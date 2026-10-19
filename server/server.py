#!/usr/bin/env python3
"""Musicstreaming server: the backend for music.js (Bruce firmware).

Finds SoundCloud and YouTube tracks and converts them, while the device plays, to small CBR MP3 pieces that
Bruce's JavaScript interpreter can fetch and play. Audio only. No accounts, no database.

Needs: Python 3.9+, `pip install flask waitress`, and `yt-dlp` and `ffmpeg` (with libmp3lame) on the PATH.
Keep yt-dlp up to date (`yt-dlp -U` or `pip install -U yt-dlp`): SoundCloud/YouTube change often.

Routes (all GET; `d=<device id>` is a random id the script makes up, each device has its own jobs and files):
  /health                              {"ok": true}
  /bruce/music/search?src=sc|yt|all&q=&n=&page=&min=&max=&clean=1&sort=rel|dur
  /bruce/music/trending?genre=&n=      SoundCloud charts (worldwide hiphop edm house techno electronic pop rock)
  /bruce/music/prepare?u=&dur=&br=&preset=&bass=&treble=&gain=&norm=&d=
  /bruce/music/chunk?id=&t=&ms=&d=     MP3 frames for [t, t+ms) milliseconds; empty 200 = end, 503 = not ready
  /bruce/music/release?id=&d=

Settings (environment variables):
  MUSIC_HOST (127.0.0.1)   MUSIC_PORT (5057)   address to listen on; use 0.0.0.0 to serve your network
  MUSIC_TOKEN              if set, every route lives under /<MUSIC_TOKEN>/... (put that in the script's server
                           address: http://host:5057/<MUSIC_TOKEN>). A plain-http token is NOT a secret on the wire.
  MUSIC_TRUST_PROXY (0)    1 = you run behind a reverse proxy (Caddy, nginx): take the client address from the LAST
                           X-Forwarded-For entry. Leave 0 if clients connect directly, or they could fake it.
  MUSIC_LAN_ONLY (0)       1 = refuse clients that are not on a private (LAN) address
  MUSIC_CACHE (./cache)    where converted files live (deleted after use)
  MUSIC_MAX_JOBS (4)       conversions running at once       MUSIC_MAX_PER_IP (3)   ... per client address
  MUSIC_CACHE_MB (2048)    most disk used by converted files MUSIC_DAILY_MB (2048)  audio one address may fetch per day
  MUSIC_MAX_MIN (30)       longest track in minutes   MUSIC_MAX_INFLIGHT (6)  open requests one address may have
  MUSIC_SONGS_PER_HOUR (40) different tracks one device may start per hour (an address gets 5x that, as a backstop)
"""

import hashlib
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from flask import Blueprint, Flask, Response, abort, g, jsonify, request
from werkzeug.exceptions import HTTPException

HOST = os.environ.get("MUSIC_HOST", "127.0.0.1")
PORT = int(os.environ.get("MUSIC_PORT", "5057"))
TOKEN = re.sub(r"[^A-Za-z0-9_-]", "", os.environ.get("MUSIC_TOKEN", ""))
TRUST_PROXY = os.environ.get("MUSIC_TRUST_PROXY", "0") == "1"
LAN_ONLY = os.environ.get("MUSIC_LAN_ONLY", "0") == "1"
CACHE = Path(os.environ.get("MUSIC_CACHE", Path(__file__).resolve().parent / "cache"))
MAX_WORKING = int(os.environ.get("MUSIC_MAX_JOBS", "4"))
MAX_PER_IP = int(os.environ.get("MUSIC_MAX_PER_IP", "3"))
MAX_CACHE_BYTES = int(os.environ.get("MUSIC_CACHE_MB", "2048")) * 1048576
DAILY_BYTES = int(os.environ.get("MUSIC_DAILY_MB", "2048")) * 1048576
MAX_AUDIO_SECONDS = int(os.environ.get("MUSIC_MAX_MIN", "30")) * 60
MAX_INFLIGHT = int(os.environ.get("MUSIC_MAX_INFLIGHT", "6"))   # simultaneous requests one address may have open
KEEP_PER_DEVICE = 2                    # the current track + the prefetched next one
IDLE_DONE_S, IDLE_WORKING_S = 600, 900  # forget finished / abandoned jobs after this

YTDLP = shutil.which("yt-dlp") or "yt-dlp"
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"

app = Flask(__name__)
bp = Blueprint("music", __name__)

# Only SoundCloud and YouTube page URLs are ever handed to yt-dlp/ffmpeg, so a client can't make the server
# fetch arbitrary addresses.
SC_URL = re.compile(r"^https://(?:www\.|m\.)?soundcloud\.com/[A-Za-z0-9_./%~+-]+(?:\?[A-Za-z0-9_=&%.~+-]*)?$"
                    r"|^https://on\.soundcloud\.com/[A-Za-z0-9]+$")
YT_URL = re.compile(r"^https://(?:www\.|m\.|music\.)?youtube\.com/watch\?v=([A-Za-z0-9_-]{6,20})(?:&[A-Za-z0-9_=&%.~+-]*)?$"
                    r"|^https://youtu\.be/([A-Za-z0-9_-]{6,20})(?:\?[A-Za-z0-9_=&%.~+-]*)?$")
GENRES = {
    "worldwide": "trending soundcloud", "hiphop": "hip hop trending", "edm": "edm trending",
    "house": "house music trending", "techno": "techno trending", "electronic": "electronic trending",
    "pop": "pop trending", "rock": "rock trending",
}


# ───────────────────────── helpers ─────────────────────────

def client_ip():
    ra = request.remote_addr or ""
    if TRUST_PROXY:
        xff = request.headers.get("X-Forwarded-For", "")
        if xff:
            return xff.split(",")[-1].strip() or ra
    return ra


def _int(name, default, lo, hi):
    try:
        v = int(request.args.get(name, default))
    except ValueError:
        abort(400, f"bad {name}")
    return max(lo, min(v, hi))


def _key(url):
    return hashlib.sha1(url.encode()).hexdigest()[:12]


def _yt_id(url):
    m = YT_URL.match(url or "")
    return (m.group(1) or m.group(2)) if m else None


def _track_url(u):
    u = (u or "").strip()
    if len(u) > 300:
        abort(400, "URL too long")
    yid = _yt_id(u)
    if yid:
        return f"https://www.youtube.com/watch?v={yid}"     # canonical, so the id is stable
    if not SC_URL.match(u):
        abort(400, "not a SoundCloud or YouTube URL")
    return u


_HITS, _BYTES, _INFLIGHT, HLOCK = {}, {}, {}, threading.Lock()


def _hit(bucket, limit, window=60):
    """Counts one request of this client in `bucket`; 429 when it exceeds `limit` per `window` seconds."""
    ip, now = client_ip(), time.time()
    with HLOCK:
        hits = [t for t in _HITS.get((bucket, ip), []) if now - t < window]
        if len(hits) >= limit:
            abort(429, "too many requests, slow down")
        hits.append(now)
        _HITS[(bucket, ip)] = hits
        if len(_HITS) > 5000:
            for k in [k for k, v in _HITS.items() if not v or now - v[-1] > window]:
                del _HITS[k]


SONGS_PER_HOUR = int(os.environ.get("MUSIC_SONGS_PER_HOUR", "40"))            # different tracks one device may start per hour
IP_SONGS_PER_HOUR = int(os.environ.get("MUSIC_IP_SONGS_PER_HOUR", str(SONGS_PER_HOUR * 5)))   # ... and one address, whatever ids it sends
_SONGS = {}


def _song_quota(key, dev, ip):
    """A device (and, as a backstop against made-up ids, an address) may start only so many different tracks per
    hour. Starting the same track again (other EQ, replay) is free. Raises 429 when the limit is reached."""
    now = time.time()
    with HLOCK:
        for who, limit in ((("d", dev), SONGS_PER_HOUR), (("i", ip), IP_SONGS_PER_HOUR)):
            seen = {k: t for k, t in _SONGS.get(who, {}).items() if now - t < 3600}
            if key not in seen and len(seen) >= limit:
                abort(429, f"limit reached: {limit} songs per hour" + (" for this device" if who[0] == "d" else " from this address"))
            _SONGS[who] = seen
        for who in (("d", dev), ("i", ip)):
            _SONGS[who][key] = now
        if len(_SONGS) > 5000:
            for w in [w for w, v in _SONGS.items() if not v or now - max(v.values()) > 3600]:
                del _SONGS[w]


def _daily_ok(add):
    day, ip = int(time.time() // 86400), client_ip()
    with HLOCK:
        d0, n = _BYTES.get(ip, (day, 0))
        if d0 != day:
            n = 0
        if n + add > DAILY_BYTES:
            return False
        _BYTES[ip] = (day, n + add)
        return True


def _dev():
    """The device's own id (random, made up by the script) or, without one, the client address. Not a secret: the
    per-address limits above apply to everyone whatever id they send."""
    d = request.args.get("d") or ""
    return d if re.fullmatch(r"[A-Za-z0-9]{4,24}", d) else "ip" + re.sub(r"[^0-9a-f]", "", client_ip().lower())[:20]


@app.before_request
def _guard():
    if LAN_ONLY:
        try:
            ip = ipaddress.ip_address(client_ip())
        except ValueError:
            abort(403, "forbidden")
        if not (ip.is_private or ip.is_loopback):
            abort(403, "this server is for the local network only")
    if not request.path.endswith(("/health", "/music/chunk")):      # chunk has its own limit
        _hit("all", 240)
    # A chunk request can wait for the converter for up to 22 s: without a cap, a few open connections from one
    # address would tie up every worker thread.
    ip = client_ip()
    with HLOCK:
        if _INFLIGHT.get(ip, 0) >= MAX_INFLIGHT:
            abort(429, "too many simultaneous requests")
        _INFLIGHT[ip] = _INFLIGHT.get(ip, 0) + 1
    g.inflight_ip = ip


@app.teardown_request
def _done(_exc):
    ip = g.pop("inflight_ip", None)
    if ip:
        with HLOCK:
            _INFLIGHT[ip] = max(0, _INFLIGHT.get(ip, 1) - 1)
            if not _INFLIGHT[ip]:
                del _INFLIGHT[ip]


@app.after_request
def _headers(r):
    r.headers["Cache-Control"] = "no-store"
    return r


@app.errorhandler(HTTPException)
def _err(e):
    return jsonify({"error": e.description}), e.code


# ───────────────────────── search ─────────────────────────

_SEARCH_CACHE, _SEARCH_LOCK, _SEARCH_TTL = {}, threading.Lock(), 600
_tls = threading.local()


def _innertube_search(q):
    """YouTube's own search endpoint over a kept-alive connection (~0.5 s); yt-dlp is the fallback."""
    import http.client
    body = json.dumps({
        "context": {"client": {"clientName": "WEB", "clientVersion": "2.20250101.00.00", "hl": "en", "gl": "US"}},
        "query": q, "params": "EgIQAQ%3D%3D",   # videos only
    }).encode()
    headers = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0", "Content-Length": str(len(body))}
    for attempt in (0, 1):
        conn = getattr(_tls, "conn", None)
        try:
            if conn is None:
                conn = _tls.conn = http.client.HTTPSConnection("www.youtube.com", timeout=10)
            conn.request("POST", "/youtubei/v1/search?prettyPrint=false", body, headers)
            resp = conn.getresponse()
            data = resp.read()
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
            break
        except Exception:  # noqa: BLE001  (a stale keep-alive connection: reconnect once)
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            _tls.conn = None
            if attempt:
                raise
    doc = json.loads(data)
    out = []
    sections = doc["contents"]["twoColumnSearchResultsRenderer"]["primaryContents"]["sectionListRenderer"]["contents"]
    for sec in sections:
        for item in sec.get("itemSectionRenderer", {}).get("contents", []):
            v = item.get("videoRenderer")
            if not v or not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", v.get("videoId", "")):
                continue
            title = "".join(r.get("text", "") for r in v.get("title", {}).get("runs", []))
            owner = v.get("ownerText") or v.get("longBylineText") or {}
            channel = "".join(r.get("text", "") for r in owner.get("runs", []))
            secs = 0
            for part in (v.get("lengthText", {}).get("simpleText") or "").split(":"):
                secs = secs * 60 + int(part) if part.isdigit() else secs
            out.append({"id": v["videoId"], "title": title, "channel": channel, "duration": secs})
    if not out:
        raise RuntimeError("no results parsed")
    return out


def _ytdlp_search(q, n):
    fmt = "%(id)s\t%(title)s\t%(uploader)s\t%(duration)s\n"
    p = subprocess.run([YTDLP, f"ytsearch{n}:{q}", "--flat-playlist", "--print", fmt, "--no-warnings"],
                       capture_output=True, text=True, timeout=30)
    out = []
    for line in p.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 4 or not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", parts[0]):
            continue
        try:
            dur = int(float(parts[3]))
        except ValueError:
            dur = 0
        out.append({"id": parts[0], "title": parts[1], "channel": parts[2], "duration": dur})
    return out


def search_videos(q, n):
    key, now = (q.lower(), n), time.time()
    with _SEARCH_LOCK:
        hit = _SEARCH_CACHE.get(key)
        if hit and now - hit[0] < _SEARCH_TTL:
            return hit[1]
    try:
        if n > 18:
            raise RuntimeError("more than one result page wanted")   # the first InnerTube page has ~20
        out = _innertube_search(q)[:n]
    except Exception as e:  # noqa: BLE001
        print(f"innertube search failed ({e}); falling back to yt-dlp", flush=True)
        out = _ytdlp_search(q, n)
    with _SEARCH_LOCK:
        if len(_SEARCH_CACHE) > 200:
            for k in sorted(_SEARCH_CACHE, key=lambda k: _SEARCH_CACHE[k][0])[:100]:
                del _SEARCH_CACHE[k]
        _SEARCH_CACHE[key] = (now, out)
    return out


def _scsearch(query, n):
    fmt = "%(webpage_url)s\t%(title)s\t%(uploader)s\t%(duration)s\n"
    p = subprocess.run([YTDLP, f"scsearch{n}:{query}", "--flat-playlist", "--print", fmt, "--no-warnings"],
                       capture_output=True, text=True, timeout=40)
    out = []
    for line in p.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        url, title, uploader, dur = parts[:4]
        if not SC_URL.match(url) or "/sets/" in url:
            continue
        try:
            dur_s = int(float(dur))
        except ValueError:
            continue                    # no duration: a playlist / profile entry, not a track
        out.append({"id": _key(url), "url": url, "title": title, "uploader": uploader, "duration": dur_s})
    return out


_BAD = re.compile(r"\b(slowed|sped ?up|speed ?up|nightcore|8d|karaoke|reverb|bass ?boosted|cover|remix|mashup|loop|1 ?hour|10 ?hours?)\b", re.I)


def _norm(s):
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower())


def _score(it, toks):
    """Relevance: query words in the title (whole word > part) and the uploader, all words present, and a
    preference for normal song lengths over snippets and hour-long mixes."""
    title, up = _norm(it["title"]), _norm(it["uploader"])
    words, s = title.split(), 0
    for t in toks:
        if t in words:
            s += 3
        elif t in title:
            s += 1
        if t in up:
            s += 2
    if toks and all(t in title or t in up for t in toks):
        s += 5
    d = it["duration"]
    if d < 60:
        s -= 3
    elif 120 <= d <= 600:
        s += 1
    elif d > 1200:
        s -= 2
    return s


def _fetch_source(src, q, n):
    if src == "sc":
        out = _scsearch(q, n)
        for r in out:
            r["src"] = "sc"
        return out
    out = []
    for r in search_videos(q, n):
        if r.get("duration", 0) <= 0:
            continue                    # livestream
        url = f"https://www.youtube.com/watch?v={r['id']}"
        out.append({"id": _key(url), "url": url, "title": r["title"], "uploader": r["channel"],
                    "duration": r["duration"], "src": "yt"})
    return out


@bp.route("/health")
def health():
    return jsonify({"ok": True})


@bp.route("/bruce/music/search")
def music_search():
    q = (request.args.get("q") or "").strip()
    n, page = _int("n", 15, 1, 25), _int("page", 1, 1, 4)
    src = request.args.get("src", "all")
    if src not in ("sc", "yt", "all"):
        abort(400, "src must be sc, yt or all")
    dmin, dmax = _int("min", 0, 0, 36000), _int("max", 0, 0, 36000)
    clean, sort = request.args.get("clean") == "1", request.args.get("sort", "rel")
    if not q:
        return jsonify([])
    if len(q) > 100:
        abort(400, "query too long")
    want = n * page + 8                                   # enough for the requested page after filtering
    srcs = ["sc", "yt"] if src == "all" else [src]
    per = min(45, (want // len(srcs)) + 6) if len(srcs) > 1 else min(45, want + 6)
    results, errors = {}, []

    def work(s):
        try:
            results[s] = _fetch_source(s, q, per)
        except Exception as e:  # noqa: BLE001
            errors.append(str(e)[:60])
    threads = [threading.Thread(target=work, args=(s,)) for s in srcs]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=50)
    items = [it for s in srcs for it in results.get(s, [])]
    if not items and errors:
        abort(502, "search failed")

    toks = [t for t in _norm(q).split() if t]
    seen, out = set(), []
    for rank, it in enumerate(items):
        d = it["duration"]
        if d <= 0 or (dmin and d < dmin) or (dmax and d > dmax):
            continue
        if clean and _BAD.search(it["title"]) and not _BAD.search(q):      # unless the query asks for remixes etc.
            continue
        key = (_norm(it["title"])[:40], d // 3)
        if key in seen:
            continue                                      # the same song twice (e.g. re-uploads)
        seen.add(key)
        it["_s"], it["_r"] = _score(it, toks), rank
        out.append(it)
    out.sort(key=(lambda it: (it["duration"], it["_r"])) if sort == "dur" else (lambda it: (-it["_s"], it["_r"])))
    out = out[(page - 1) * n: page * n]
    for it in out:
        it.pop("_s", None)
        it.pop("_r", None)
    return jsonify(out)


@bp.route("/bruce/music/trending")
def music_trending():
    genre = (request.args.get("genre") or "worldwide").lower()
    if genre not in GENRES:
        abort(400, "unknown genre")
    n = _int("n", 20, 1, 30)
    try:
        res = _scsearch(GENRES[genre], n + 8)
    except Exception:  # noqa: BLE001
        abort(502, "charts failed")
    return jsonify([dict(r, src="sc") for r in res if r["duration"] >= 60][:n])


# ───────────────────────── stream source ─────────────────────────

# Resolving a YouTube video to its audio URL is the slow step (a yt-dlp run): cache it, and let concurrent
# requests for the same video share one run.
_URL_CACHE, _URL_LOCKS, _URL_GUARD, _URL_TTL = {}, {}, threading.Lock(), 50 * 60


def _resolve_youtube(video_id):
    with _URL_GUARD:
        hit = _URL_CACHE.get(video_id)
        if hit and time.time() - hit[0] < _URL_TTL:
            return hit[1]
        lock = _URL_LOCKS.setdefault(video_id, threading.Lock())
    with lock:
        with _URL_GUARD:
            hit = _URL_CACHE.get(video_id)
            if hit and time.time() - hit[0] < _URL_TTL:
                return hit[1]
        url = None
        for clients in ("android", "web_embedded,android,web"):      # fast first, the thorough set as the fallback
            p = subprocess.run(
                [YTDLP, "--extractor-args", f"youtube:player_client={clients}", "-f", "bestaudio/best", "-g",
                 "--no-warnings", "--no-playlist", f"https://www.youtube.com/watch?v={video_id}"],
                capture_output=True, text=True, timeout=60)
            urls = [ln for ln in p.stdout.splitlines() if ln.startswith("http")]
            if urls:
                url = urls[0]
                break
        if not url:
            raise RuntimeError("could not resolve a stream URL (unavailable, or yt-dlp needs updating)")
        with _URL_GUARD:
            if len(_URL_CACHE) > 300:
                for k in sorted(_URL_CACHE, key=lambda k: _URL_CACHE[k][0])[:150]:
                    del _URL_CACHE[k]
                    _URL_LOCKS.pop(k, None)
            _URL_CACHE[video_id] = (time.time(), url)
        return url


def _stream_source(url):
    yid = _yt_id(url)
    if yid:
        return _resolve_youtube(yid)
    p = subprocess.run([YTDLP, "-f", "bestaudio/best", "-g", "--no-warnings", "--no-playlist", url],
                       capture_output=True, text=True, timeout=40)
    urls = [ln for ln in p.stdout.splitlines() if ln.startswith("http")]
    if not urls:
        raise RuntimeError("could not resolve a stream URL (track unavailable, or yt-dlp needs updating)")
    return urls[0]


# ───────────────────────── conversion ─────────────────────────

# MP3 header -> frame length in bytes (MPEG-1 Layer III only, which is all the converter produces)
_BR = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
_SR = [44100, 48000, 32000, 0]
FRAME_MS = 1152 * 1000.0 / 44100  # one MP3 frame = 26.12 ms


def _frame_len(h):
    if len(h) < 4 or h[0] != 0xFF or (h[1] & 0xFE) != 0xFA:   # sync + MPEG-1 + Layer III
        return 0
    br, sr = _BR[(h[2] >> 4) & 15], _SR[(h[2] >> 2) & 3]
    if not br or not sr:
        return 0
    return 144000 * br // sr + ((h[2] >> 1) & 1)


EQ_PRESETS = {
    "flat": "",
    "bass": "bass=g=7:f=110:w=0.7",
    "treble": "treble=g=6:f=5000:w=0.7",
    "loud": "bass=g=5:f=100:w=0.7,treble=g=4:f=6000:w=0.7",
    "vocal": "equalizer=f=250:t=q:w=1:g=-2,equalizer=f=2000:t=q:w=1:g=3,equalizer=f=4000:t=q:w=1:g=2",
    "clear": "bass=g=-2:f=150:w=0.7,treble=g=4:f=7000:w=0.7",
    "night": "acompressor=threshold=-24dB:ratio=4:attack=5:release=200,volume=3dB",
}


def _build_af():
    """ffmpeg audio filter chain from the request: preset + bass/treble + gain (+ loudness normalisation),
    always ending in a limiter so boosts can't clip."""
    preset = request.args.get("preset", "flat")
    if preset not in EQ_PRESETS:
        abort(400, "unknown preset")
    bass, treble = _int("bass", 0, -10, 10), _int("treble", 0, -10, 10)
    gain, norm = _int("gain", 0, -12, 12), _int("norm", 0, 0, 1)
    parts = [EQ_PRESETS[preset]] if EQ_PRESETS[preset] else []
    if bass:
        parts.append(f"bass=g={bass}:f=110:w=0.7")
    if treble:
        parts.append(f"treble=g={treble}:f=5000:w=0.7")
    if gain:
        parts.append(f"volume={gain}dB")
    if norm:
        parts.append("dynaudnorm=f=250:g=15:p=0.9")
    parts.append("alimiter=limit=0.95")
    return ",".join(parts)


BJOBS, BLOCK = {}, threading.Lock()   # (track id, device) -> job


def _kill(job):
    job["cancelled"] = True
    try:
        job["proc"].kill()
    except Exception:  # noqa: BLE001
        pass


def _drop(jk):
    job = BJOBS.pop(jk, None)
    if job:
        if job["state"] == "working":
            _kill(job)
        shutil.rmtree(job["dir"], ignore_errors=True)


def _cache_bytes():
    return sum(j.get("size", 0) for j in BJOBS.values())


def _run_music(url, dur, br, af, job):
    """ffmpeg writes the MP3 to a file as fast as it can and the chunk route serves it while it grows, so playback
    can start after the first seconds. The bit reservoir is off, so every frame is self-contained: any run of
    whole frames is a valid MP3 file of its own."""
    try:
        job["dir"].mkdir(parents=True, exist_ok=True)
        out = job["file"]    # one file per job: a restarted job must never read the previous job's bytes
        proc = subprocess.Popen(
            [FFMPEG, "-loglevel", "error", "-nostdin", "-y", "-i", _stream_source(url), "-vn", "-af", af, "-ac", "1",
             "-ar", "44100", "-c:a", "libmp3lame", "-b:a", f"{br}k", "-reservoir", "0", "-write_xing", "0",
             "-id3v2_version", "0", "-map_metadata", "-1", "-f", "mp3", str(out)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        job["proc"] = proc
        expected = max(1, dur * br * 125)
        while proc.poll() is None:
            time.sleep(0.15)
            try:
                job["size"] = out.stat().st_size
                job["pct"] = min(99, int(100 * job["size"] / expected))
            except OSError:
                pass
        if job.get("cancelled"):
            return
        if proc.returncode != 0 or not out.exists() or out.stat().st_size < 1000:
            raise RuntimeError("audio conversion failed")
        job["size"] = out.stat().st_size
        job["pct"] = 100
        job["state"] = "done"
    except Exception as e:  # noqa: BLE001
        if not job.get("cancelled"):
            job["state"] = "error"
            job["error"] = str(e)[:120]


def _index_frames(job, path):
    """Extends job["fidx"] (byte offset of every complete frame) over the bytes written so far."""
    fidx = job.setdefault("fidx", [])
    pos, size = job.get("fpos", 0), job["size"]
    if pos >= size - 4:
        return
    with open(path, "rb") as f:
        f.seek(pos)
        data = f.read(size - pos)
    i = 0
    while i + 4 <= len(data):
        fl = _frame_len(data[i:i + 4])
        if not fl:
            i += 1          # not a header: resync
            continue
        if i + fl > len(data):
            break           # incomplete frame: the rest isn't written yet
        fidx.append(pos + i)
        i += fl
    job["fpos"] = pos + i


def _music_key():
    k = request.args.get("id") or ""
    if not re.fullmatch(r"[0-9a-f]{12}", k):
        abort(400, "bad id")
    return k


@bp.route("/bruce/music/prepare")
def music_prepare():
    _hit("prepare", 20)
    url = _track_url(request.args.get("u"))
    key, dev, ip = _key(url), _dev(), client_ip()
    dur = _int("dur", 0, 0, 24 * 3600)
    if dur <= 0 or dur > MAX_AUDIO_SECONDS:
        abort(400, f"track too long or live (max {MAX_AUDIO_SECONDS // 60} min)")
    br = _int("br", 96, 48, 192)
    af = _build_af()
    jk = (key, dev)
    with BLOCK:
        job = BJOBS.get(jk)
        if job and job["state"] in ("working", "done") and job["params"] == (br, af):
            job["ts"] = time.time()
            return jsonify({"state": job["state"], "id": key})
        _song_quota(key, dev, ip)                       # before anything is stopped or started
        mine = [k for k in BJOBS if k[1] == dev]
        for k in mine:                                  # this device moved on: stop its other running conversions
            if k != jk and BJOBS[k]["state"] == "working":
                _drop(k)
        mine = sorted((k for k in mine if k in BJOBS and k != jk), key=lambda k: BJOBS[k]["ts"])
        while len(mine) >= KEEP_PER_DEVICE:             # and keep only the newest finished ones
            _drop(mine.pop(0))
        if job and job["state"] == "working":           # other EQ settings: stop the old conversion first
            _kill(job)
        working = [j for j in BJOBS.values() if j["state"] == "working"]
        if not (job and job["state"] == "working"):
            if len(working) >= MAX_WORKING:
                abort(503, "server busy, try again in a moment")
            if sum(1 for j in working if j.get("ip") == ip) >= MAX_PER_IP:
                abort(429, "too many conversions from this address")
            if _cache_bytes() > MAX_CACHE_BYTES:
                abort(503, "server storage full, try again later")
        if job:
            _drop(jk)
        d = CACHE / f"{key}_{dev}"
        job = {"state": "working", "pct": 0, "error": "", "ts": time.time(), "params": (br, af), "size": 0, "ip": ip,
               "dir": d, "file": d / f"audio_{int(time.time() * 1000)}.mp3"}
        BJOBS[jk] = job
    threading.Thread(target=_run_music, args=(url, dur, br, af, job), daemon=True).start()
    return jsonify({"state": "working", "id": key})


@bp.route("/bruce/music/status")
def music_status():
    _hit("status", 120)
    job = BJOBS.get((_music_key(), _dev()))
    if not job:
        return jsonify({"state": "none", "pct": 0})
    job["ts"] = time.time()
    return jsonify({"state": job["state"], "pct": job["pct"], "error": job.get("error", ""), "size": job["size"]})


@bp.route("/bruce/music/chunk")
def music_chunk():
    _hit("chunk", 400)
    job = BJOBS.get((_music_key(), _dev()))
    if not job:
        abort(404, "unknown id")
    t_ms, ms = _int("t", 0, 0, 24 * 3600 * 1000), _int("ms", 30000, 1000, 180000)
    a, b_ = int(round(t_ms / FRAME_MS)), int(round((t_ms + ms) / FRAME_MS))   # frames [a, b_): neighbours join exactly
    path = job["file"]
    deadline = time.time() + 22
    while True:
        job["ts"] = time.time()
        if job["state"] == "error":
            abort(502, job["error"] or "conversion failed")
        if path.exists():
            _index_frames(job, path)
        have, done = len(job.get("fidx", [])), job["state"] == "done"
        if done or have >= b_ + 1 or time.time() > deadline:
            break
        time.sleep(0.12)
    fidx = job.get("fidx", [])
    if a >= len(fidx):
        if done:
            return Response(b"", mimetype="audio/mpeg", headers={"X-Done": "1"})     # past the end: the track is over
        abort(503, "not ready yet")
    end = fidx[b_] if b_ < len(fidx) else job.get("fpos", 0)
    if not _daily_ok(end - fidx[a]):
        abort(429, "daily audio limit reached for this address")
    with open(path, "rb") as f:
        f.seek(fidx[a])
        data = f.read(end - fidx[a])
    return Response(data, mimetype="audio/mpeg", headers={"X-Done": "1" if done and b_ >= len(fidx) else "0"})


@bp.route("/bruce/music/release")
def music_release():
    key = _music_key()
    with BLOCK:
        _drop((key, _dev()))
    return jsonify({"ok": True})


def cleanup_loop():
    while True:
        time.sleep(60)
        now = time.time()
        with BLOCK:
            for jk in list(BJOBS):
                j = BJOBS[jk]
                if now - j["ts"] > (IDLE_WORKING_S if j["state"] == "working" else IDLE_DONE_S):
                    _drop(jk)


app.register_blueprint(bp, url_prefix=f"/{TOKEN}" if TOKEN else "")


def main():
    for tool, path in (("yt-dlp", YTDLP), ("ffmpeg", FFMPEG)):
        if not shutil.which(path):
            print(f"WARNING: {tool} not found on PATH: install it first.", file=sys.stderr)
    shutil.rmtree(CACHE, ignore_errors=True)       # leftovers of a previous run
    CACHE.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=cleanup_loop, daemon=True).start()
    print(f"Musicstreaming server on http://{HOST}:{PORT}/{TOKEN}", flush=True)
    try:
        from waitress import serve
        serve(app, host=HOST, port=PORT, threads=32, connection_limit=300, channel_timeout=30,
              max_request_header_size=8192, max_request_body_size=1024)
    except ImportError:
        print("waitress not installed: using Flask's development server (pip install waitress)", file=sys.stderr)
        app.run(host=HOST, port=PORT, threaded=True)


if __name__ == "__main__":
    main()
