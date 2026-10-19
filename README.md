# Musicstreaming for Bruce

An audio-only SoundCloud + YouTube player for the [Bruce](https://github.com/BruceDevices/firmware) firmware's
JavaScript interpreter (T-Embed and other Bruce devices with a speaker and an SD card).

> **Status: not tested on a real Bruce device.** It was written against Bruce's interpreter source and run under
> MicroQuickJS with a mock of Bruce's API and against a live server. Expect rough edges and please report them.

## What you need

1. A Bruce device with SD card and speaker, connected to WiFi (do that in Bruce's own WiFi menu first).
2. **A server.** Bruce can't decode SoundCloud/YouTube streams itself, so the script talks to a small HTTP server
   that finds, downloads and converts the audio (yt-dlp + ffmpeg). The script uses a shared public server by default
   (see "The shared server" below), or you host your own: [`server/`](server/) is a single Python file (see "Host the
   server").

## Install

1. Copy `music.js` to the SD card, e.g. `/BruceScripts/music.js`.
2. Run it from Bruce's JS menu. On first start it asks for the server address (it is kept in
   `/musicstreaming_server.txt` on the SD card; *Settings > Change server* edits it). You can also fill in `SERVER`,
   `SERVER_LAN` and `SERVER_HTTP` at the top of the script; they are tried in that order of preference (LAN first).

## Using it

- **Search SoundCloud / Search YouTube / Search both**: ranked results; *Filters / source* hides remix / cover /
  slowed, sets a minimum length, sorts by length; *Load more results* pages on; recent searches are remembered.
- **Trends**: SoundCloud charts by genre.
- **Playing**: the whole track is loaded first (progress bar), then played. Any key stops the sound and shows the
  seek screen: **turn = seek back / forward** (8 s steps), **press = play from there**, **back = menu** (next /
  previous track, sound, stop).
- **Sound / EQ**: presets (bass, treble, loudness, voice, clear, night), bass and treble in dB, gain, loudness
  normalisation. The server applies it, so a change reloads the track.
- **Quality**: 48 / 64 / 96 kbit/s (*Settings*). Lower loads faster.
- **Queue**, shuffle, repeat; **My downloads** keeps MP3s with their title in `/Musicstreaming` for offline play.
- **Diagnostics** checks WiFi, server, search and SD writing; **Audio test** plays 6 s and reports how long
  `audio.playFile` really played; **Last run** shows the step log (`/Musicstreaming/trace.txt`) that survives a crash.

Temporary files live in `/Musicstreaming/cache` and are always deleted (after each track, on errors, at exit).

## Why it works the way it does

- `audio.playFile()` blocks until the end of the file and any key press stops it, and Bruce can't stream. So the
  track is loaded as small 8 s MP3 files that join without a gap and played one after another.
- Bruce's `httpFetch` puts the whole answer into one JS string and the JS heap is only 256-512 KB, so one download
  request is at most 12 s of audio.
- Bruce's interpreter is MicroQuickJS (an ES5 subset): no `encodeURIComponent`, no typed-array `slice`, and
  `dialog.choice` returns the label. The script's menus are drawn by the script itself.

## The shared server

The script's default address (`SERVER_HTTP` at the top of `music.js`) is a small public server run by the author, so
you can try it without hosting anything. Please know:

- **Best effort, may change or disappear.** It runs on a Raspberry Pi at someone's home. Limits keep it fair:
  40 different songs per hour per device, tracks up to 12 minutes, 2 conversions at once per address, 1 GB of audio per
  day per address, 3 conversions at once for everyone. If it is busy you get "server busy": try again.
- **No account, no password, nothing secret is sent.** The address is plain `http`, because Bruce's TLS stack often
  can't connect: anyone on the network path (your WiFi, your provider) can see what you search and play.
- **The server sees your IP address and what you search and play** (its web server keeps access logs). It is a separate,
  locked-down service on its own user, with no access to anything else on that machine.
- The author can't promise that nothing can go wrong with a public service. If you want to be independent of it,
  host your own (next section) and set it under *Settings > Change server*.

## Host the server

`server/server.py` is the complete backend (search, charts, conversion). It has no accounts and no database.

```sh
sudo apt install ffmpeg python3-venv          # ffmpeg must include libmp3lame (the Debian/Ubuntu package does)
python3 -m venv venv && . venv/bin/activate
pip install -r server/requirements.txt         # flask, waitress, yt-dlp
MUSIC_HOST=0.0.0.0 MUSIC_TOKEN=some-long-random-string MUSIC_LAN_ONLY=1 python server/server.py
```

Then give the script `http://<server ip>:5057/some-long-random-string` (it asks on first start, or edit
`SERVER_LAN` at the top). `server/music-server.service` is a systemd example. Keep yt-dlp current
(`pip install -U yt-dlp`): SoundCloud and YouTube change often and old versions stop working.

Settings are environment variables, all documented at the top of `server.py`:

| variable | default | meaning |
|---|---|---|
| `MUSIC_HOST` / `MUSIC_PORT` | `127.0.0.1` / `5057` | listen address (use `0.0.0.0` for your network) |
| `MUSIC_TOKEN` | empty | if set, all routes live under `/<token>/...`; part of the address you give the script |
| `MUSIC_LAN_ONLY` | `0` | `1` refuses clients that aren't on a private address |
| `MUSIC_TRUST_PROXY` | `0` | `1` behind a reverse proxy: client address = last `X-Forwarded-For` entry |
| `MUSIC_MAX_JOBS` / `MUSIC_MAX_PER_IP` | `4` / `3` | conversions at once, in total / per client address |
| `MUSIC_CACHE_MB` / `MUSIC_DAILY_MB` | `2048` / `2048` | disk for converted files / audio one address may fetch per day |
| `MUSIC_MAX_MIN` | `30` | longest track in minutes |

**Using it from outside your home network:** Bruce's TLS stack could not connect to the author's HTTPS server, so
the author uses a plain-HTTP address; a token in a plain-HTTP address is readable by anyone on the path. Prefer a
VPN to your home network. If you do expose it, run it behind a reverse proxy (set `MUSIC_TRUST_PROXY=1`), keep a long
random `MUSIC_TOKEN`, forward only `/<token>/health` and `/<token>/bruce/music/*`, and keep the limits above on.

**Several devices** can use one server: each device sends a random id (`/Musicstreaming/device.txt`) and gets its own jobs
and files. The per-address limits can't be dodged with made-up ids.

The server was run on a Raspberry Pi (Python 3 venv, yt-dlp, ffmpeg) with the real SoundCloud and YouTube: search,
charts, conversion, joining the pieces and playing them back with ffmpeg were checked there. It has had no
long-running or heavy-load testing.

## Server routes the script uses

All answers are JSON unless noted; `d=<device id>` is the random id from above.

| route | purpose |
|---|---|
| `GET /health` | `{"ok":true}` |
| `GET /bruce/music/search?src=sc|yt|all&q=&n=&page=&min=&clean=&sort=` | list of `{id,url,title,uploader,duration,src}` |
| `GET /bruce/music/trending?genre=&n=` | same list, SoundCloud charts |
| `GET /bruce/music/prepare?u=<track url>&dur=<seconds>&br=<kbit/s>&preset=&bass=&treble=&gain=&norm=&d=` | starts converting to **CBR MP3, mono, 44.1 kHz, no ID3/Xing, bit reservoir off** |
| `GET /bruce/music/chunk?id=&t=<ms>&ms=<ms>&d=` | the MP3 frames for `[t, t+ms)` (whole frames only, so neighbours join exactly); waits for the converter; empty 200 = end of track, 503 = not ready yet (script retries) |
| `GET /bruce/music/release?id=&d=` | delete the server's copy |

You can write your own server against this table.

## Legal

Downloading or converting content from SoundCloud or YouTube may violate their terms of service or copyright law
where you live. Hosting a server that downloads and converts such content is your responsibility. You are responsible for how you use this. No affiliation with SoundCloud, YouTube or Bruce.

## Licence

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 HDMI1online.
