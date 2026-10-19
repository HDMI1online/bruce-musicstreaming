// Musicstreaming for the Bruce firmware: SoundCloud and YouTube, audio only, drawn menus.
//
// Copy to the SD card (e.g. /BruceScripts/music.js), connect Bruce to WiFi, run it from Bruce's JS menu.
// It needs a server that provides the /bruce/music/* routes (see README.md). By default it uses the shared public
// server (SERVER_HTTP below); you can host your own (server/) and set SERVER / SERVER_LAN, or type an address
// under Settings > Change server.
//
//   Search     SoundCloud, YouTube or both, ranked; filters, paging, history; "Trends" = SoundCloud charts.
//   Player     Bruce can't stream and audio.playFile() blocks (any key stops it). So the whole track is loaded
//              first as small MP3 files (8 s each, cut on frames: no gaps), then played one after another.
//              Any key stops the sound: turn = seek back / forward, press = play, back = menu (next, previous,
//              sound, stop). Temp files are always deleted.
//   Sound/EQ   Applied by the server while converting: presets, bass / treble in dB, gain, normalisation.
//   Quality    48 / 64 / 96 kbit/s (lower = loads faster).
//   Queue      play all from here, add to queue, shuffle, repeat.
//   Downloads  kept as MP3 with title in /Musicstreaming, playable offline.
//   Tools      Diagnostics, Audio test, Last run (step log that survives a crash).
//
// Tested on a Lilygo T-Embed CC1101. Written against Bruce's interpreter source (MicroQuickJS: dialog / keyboard /
// storage / audio / display behaviour as in its code) and also run under MicroQuickJS with a mock of Bruce's API
// and against a live server. Other devices are untested: the layout is made for a 320x170 screen.

var wifi = require("wifi");
var dialog = require("dialog");
var keyboard = require("keyboard");
var storage = require("storage");
var audio = require("audio");
var display = require("display");

// ---- settings ----------------------------------------------------------------------------
var SERVER = "";        // optional: your own server's https address (with its path / token)
var SERVER_LAN = "";    // optional: the server on your home network, e.g. "http://192.168.1.20:5057"
var SERVER_HTTP = "http://soosftp.duckdns.org/music";   // the shared public server (plain http: Bruce's https often fails); see README
var SERVER_FILE = "/musicstreaming_server.txt";   // an address typed in under "Change server"
var FOLDER = "/Musicstreaming";              // downloads, settings, history
var CACHE = FOLDER + "/cache";          // pieces being played
// Bruce's httpFetch copies the whole answer into one JS string, and the JS heap is only 256-512 KB: a piece must stay
// small (12 s = 144 KB) or the interpreter runs out of memory (crash, or answers without status = "HTTP undefined").
var PIECE_MS = 8000, NEXT_MS = 12000;   // PIECE_MS: one playback file (also the seek step); NEXT_MS: one download request
var MAX_MIN = 30;

// Colours: SoundCloud orange on dark.
var BG = display.color(10, 10, 14), FG = display.color(244, 244, 244), DIM = display.color(130, 130, 140);
var ACC = display.color(255, 85, 0), PANEL = display.color(30, 30, 38), YTC = display.color(235, 30, 30);

// ---- helpers -----------------------------------------------------------------------------
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function fmtDur(s) { return (!s || s <= 0) ? "?" : Math.floor(s / 60) + ":" + pad2(s % 60); }
function cut(s, n) { s = String(s || ""); return s.length > n ? s.substring(0, n - 1) + "~" : s; }
function sgn(n) { return (n > 0 ? "+" : "") + n; }

function ascii(s) {
  return String(s || "")
    .replace(/[äÄ]/g, "ae").replace(/[öÖ]/g, "oe").replace(/[üÜ]/g, "ue")
    .replace(/ß/g, "ss").replace(/[^\x20-\x7e]/g, "?");
}

// encodeURIComponent doesn't exist in Bruce's MicroQuickJS: percent-encode as UTF-8 by hand.
function urlEncode(str) {
  var out = "", hex = "0123456789ABCDEF", i, c, bytes, k;
  str = String(str);
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95 || c === 46 || c === 126) {
      out += str.charAt(i);
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(i + 1) - 0xdc00);
      i++;
    }
    if (c < 0x80) bytes = [c];
    else if (c < 0x800) bytes = [0xc0 | (c >> 6), 0x80 | (c & 63)];
    else if (c < 0x10000) bytes = [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
    else bytes = [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
    for (k = 0; k < bytes.length; k++) out += "%" + hex.charAt(bytes[k] >> 4) + hex.charAt(bytes[k] & 15);
  }
  return out;
}

// Bruce picks the internal flash for a plain path string, so name the SD card explicitly.
function sd(path) { return { fs: "sd", path: path }; }
function rm(pathObj) { try { storage.remove(pathObj); } catch (err1) { /* already gone */ } }
function listDir(dir) { try { return storage.readdir(sd(dir), { withFileTypes: true }); } catch (err2) { return []; } }
function readText(path) { try { return String(storage.read(sd(path))); } catch (err3) { return ""; } }
function writeText(path, text) { try { storage.write(sd(path), text, "write"); } catch (err4) { /* SD problem: ignore here */ } }

function fileSize(path) {
  var c = path.lastIndexOf("/"), entries = listDir(path.substring(0, c) || "/"), name = path.substring(c + 1);
  for (var i = 0; i < entries.length; i++) if (entries[i].name === name) return entries[i].size;
  return -1;
}

// Breadcrumb for crashes: the last step is kept on the SD card (menu "Last run") so a reboot still leaves a clue.
function trace(msg) {
  try { storage.write(sd(FOLDER + "/trace.txt"), nowMs() + " " + msg + "\n", "append"); } catch (errT) { /* no SD */ }
}

function fail(msg) { dialog.error(ascii(msg), true); }
function note(msg) { dialog.info(ascii(msg), false); }          // shows a message without waiting for a key
function errText(e) { return e && e.message ? e.message : String(e); }
function nowMs() { return typeof now === "function" ? now() : Date.now(); }
function cancelled() { return keyboard.getEscPress(1); }         // 1 ms: poll only

// A drawn list menu (Bruce's own dialog.choice() is a plain text box): header with title, highlighted row, scroll
// bar, key hints. Keys: next/prev move, select picks, esc cancels. Returns the index, -1 = cancelled.
// A test seam: if a global PICK function exists it answers instead of the keys.
function choose(labels, title) {
  if (typeof PICK === "function") return PICK(labels, title);
  var W = display.width(), H = display.height(), long = false, i;
  for (i = 0; i < labels.length; i++) if (labels[i].length > 22) long = true;
  var rowH = long ? 16 : 26, size = long ? 1 : 2, top = 26, rows = Math.floor((H - top - 12) / rowH);
  var sel = 0, first = 0, dirty = true, idle = 0;
  var drain = 0;
  while (drain < 6) { keyboard.getNextPress(); keyboard.getPrevPress(); keyboard.getSelPress(); keyboard.getEscPress(); delay(25); drain++; }
  while (true) {
    if (dirty) {
      if (sel < first) first = sel;
      if (sel >= first + rows) first = sel - rows + 1;
      display.fill(BG);
      display.drawFillRect(0, 0, W, 22, ACC);
      display.setTextSize(2); display.setTextColor(FG);
      display.drawString(cut(ascii(title || "Musicstreaming"), 24), 6, 3);
      for (i = 0; i < rows && first + i < labels.length; i++) {
        var y = top + i * rowH, on = first + i === sel;
        if (on) display.drawFillRoundRect(4, y, W - 14, rowH - 2, 4, ACC);
        display.setTextSize(size);
        display.setTextColor(on ? FG : DIM);
        display.drawString(cut(ascii(labels[first + i]), long ? 50 : 24), 10, y + (long ? 4 : 5));
      }
      if (labels.length > rows) {                              // scroll bar
        var th = Math.max(8, Math.floor((H - top - 12) * rows / labels.length));
        display.drawFillRect(W - 6, top + Math.floor((H - top - 12 - th) * first / (labels.length - rows)), 3, th, DIM);
      }
      display.setTextSize(1); display.setTextColor(DIM);
      display.drawString("turn = move   press = ok   back = cancel   " + (sel + 1) + "/" + labels.length, 6, H - 10);
      dirty = false;
    }
    if (keyboard.getNextPress()) { sel = (sel + 1) % labels.length; dirty = true; }
    else if (keyboard.getPrevPress()) { sel = (sel + labels.length - 1) % labels.length; dirty = true; }
    else if (keyboard.getSelPress()) return sel;
    else if (keyboard.getEscPress()) return -1;
    delay(25);
  }
}

// ---- settings (saved on the SD card) ----------------------------------------------------------
var PRESETS = ["flat", "bass", "treble", "loud", "vocal", "clear", "night"];
var PRESET_NAMES = ["Off (flat)", "Bass boost", "Treble boost", "Loudness", "Voice", "Clear", "Night (quiet)"];
var cfg = { br: 64, preset: "flat", bass: 0, treble: 0, gain: 0, norm: 0, src: "all", clean: 0, minDur: 0, sort: "rel", shuffle: 0, repeat: 0 };

function loadCfg() {
  var t = readText(FOLDER + "/settings.json");
  if (!t) return;
  try {
    var o = JSON.parse(t);
    for (var k in cfg) if (o[k] !== undefined) cfg[k] = o[k];
  } catch (err5) { /* damaged file: keep defaults */ }
}
function saveCfg() { storage.mkdir(sd(FOLDER)); writeText(FOLDER + "/settings.json", JSON.stringify(cfg)); }

function afQuery() {
  return "&preset=" + cfg.preset + "&bass=" + cfg.bass + "&treble=" + cfg.treble + "&gain=" + cfg.gain + "&norm=" + cfg.norm;
}

var history = [];
function loadHistory() { var t = readText(FOLDER + "/history.txt"); history = t ? t.split("\n").filter(function (s) { return s.length > 0; }) : []; }
function addHistory(q) {
  var out = [q];
  for (var i = 0; i < history.length && out.length < 12; i++) if (history[i] !== q) out.push(history[i]);
  history = out;
  storage.mkdir(sd(FOLDER));
  writeText(FOLDER + "/history.txt", history.join("\n"));
}


// ---- screens ------------------------------------------------------------------------------------
// Drawn by the script itself (the dialog boxes can't show a progress bar). Colours: SoundCloud orange on dark.

function bar(x, y, w, h, pct, col) {
  display.drawFillRect(x, y, w, h, PANEL);
  var f = Math.floor(w * Math.max(0, Math.min(100, pct)) / 100);
  if (f > 0) display.drawFillRect(x, y, f, h, col);
}

function header(text, col) {
  display.fill(BG);
  display.drawFillRect(0, 0, display.width(), 22, col || ACC);
  display.setTextSize(2); display.setTextColor(FG);
  display.drawString(cut(ascii(text), 24), 6, 4);
}

// A simple status screen: headline, up to two text lines, optional progress bar.
function screen(title, line1, line2, pct) {
  header("Musicstreaming");
  display.setTextSize(2); display.setTextColor(FG);
  display.drawString(cut(ascii(title), 24), 8, 36);
  display.setTextSize(1); display.setTextColor(DIM);
  if (line1) display.drawString(cut(ascii(line1), 50), 8, 66);
  if (line2) display.drawString(cut(ascii(line2), 50), 8, 80);
  if (pct >= 0) bar(8, 104, display.width() - 16, 10, pct, ACC);
}

function nowPlaying(t, posMs, n, total, status) {
  var yt = t.src === "yt", w = display.width();
  header(yt ? "YouTube" : "SoundCloud", yt ? YTC : ACC);
  display.setTextSize(1); display.setTextColor(FG);
  display.drawString((n > 1 ? "Track " + (qi + 1) + "/" + n : "Now playing"), w - 90, 8);
  display.setTextSize(2); display.setTextColor(FG);
  display.drawString(cut(ascii(t.title), 24), 8, 32);
  display.setTextSize(1); display.setTextColor(DIM);
  display.drawString(cut(ascii(t.uploader), 50), 8, 56);
  bar(8, 88, w - 16, 8, Math.floor(100 * posMs / total), yt ? YTC : ACC);
  display.setTextColor(FG);
  display.drawString(fmtDur(Math.floor(posMs / 1000)), 8, 102);
  display.drawString(fmtDur(t.duration), w - 40, 102);
  display.setTextColor(DIM);
  display.drawString("EQ: " + PRESET_NAMES[PRESETS.indexOf(cfg.preset)] + (cfg.shuffle ? "  shuffle" : "") + (cfg.repeat ? "  repeat" : ""), 8, 122);
  display.drawString(status || "any key = menu", 8, 140);
}

// ---- server ------------------------------------------------------------------------------
function customServer() {
  var v = readText(SERVER_FILE).replace(/\s+/g, "").replace(/\/+$/, "");
  return v.length > 8 ? v : "";
}

var activeBase = "";   // the address that worked in this run

function bases() {
  var custom = customServer(), out = [], last = readText(FOLDER + "/base.txt").replace(/\s+/g, "");
  if (custom) out.push(custom);
  else {
    if (last) out.push(last);                // what worked the last time goes first: no waiting for dead addresses
    var all = [SERVER_LAN, SERVER_HTTP, SERVER, SERVER.replace(/^(https?:\/\/[^\/:]+)(\/.*)$/, "$1:8443$2")];
    for (var i = 0; i < all.length; i++) if (all[i].length > 8 && all[i] !== last) out.push(all[i]);
  }
  return out;
}

// A random id per device (kept on the SD card): several devices can use the same server, each with its own files and
// conversions. It is not a password.
var deviceId = "";
function devId() {
  if (deviceId) return deviceId;
  var t = readText(FOLDER + "/device.txt").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9]{8,24}$/.test(t)) {
    var abc = "abcdefghijklmnopqrstuvwxyz0123456789";
    t = "";
    for (var i = 0; i < 12; i++) t += abc.charAt(Math.floor(Math.random() * abc.length));
    storage.mkdir(sd(FOLDER));
    writeText(FOLDER + "/device.txt", t);
  }
  deviceId = t;
  return deviceId;
}

function fetchAny(path, opts) {
  if (path.indexOf("/bruce/music/") === 0) path += "&d=" + devId();
  var list = activeBase ? [activeBase] : bases(), last = null, i, r;
  for (var pass = 0; pass < 2; pass++) {
    for (i = 0; i < list.length; i++) {
      try {
        r = wifi.httpFetch(list[i] + path, opts);
        if (activeBase !== list[i]) { activeBase = list[i]; storage.mkdir(sd(FOLDER)); writeText(FOLDER + "/base.txt", activeBase); }
        return r;
      } catch (err6) {
        last = err6;
        if (activeBase === list[i]) activeBase = "";
      }
    }
    if (pass === 0 && list.length === 1 && activeBase === "") list = bases(); else break;
  }
  throw last;
}

function get(path) {                    // JSON answer
  var what = path.split("?")[0], r;
  try {
    r = fetchAny(path, { method: "GET", responseType: "json" });
  } catch (err7) {
    var em = errText(err7);
    if (em.indexOf("refused") >= 0) em += " (server not reachable)";
    throw new Error(what + ": " + em);
  }
  if (!r || !r.ok) {
    var msg = "HTTP " + (r && r.status !== undefined ? r.status : "? (script out of memory?)");
    if (r && r.body && r.body.error) msg += ": " + r.body.error;
    throw new Error(what + ": " + msg);
  }
  return r.body;
}

// Bruce's wifi.connected() is a flag that stays false when the connection came from somewhere else (Launcher, an
// earlier dialog), and wifi.connectDialog() returns false at once when the radio is already connected (or says
// "WiFi busy" for half a second). So: if the flag is false, a quick request to the server decides; only when that
// fails the connect dialog is opened. A dialog that returns within 1.5 s was "already connected / busy": retry
// a few times; a longer one was the person leaving the list: stop. Never blocks the script: a real problem shows
// up as a failed request ("server not reachable").
function onlineNow() {
  try { var b0 = activeBase || bases()[0]; if (!b0) return false; var pr = wifi.httpFetch(b0 + "/health", { method: "GET" }); return !!(pr && pr.status > 0); }
  catch (errO) { return false; }
}

function ensureWifi() { return wifi.connected() || onlineNow(); }

var WIFI_HINT = "Connect to WiFi first (Bruce menu: WiFi > Connect), then start this script again.";

// ---- sound menu -------------------------------------------------------------------------------
function pickNumber(title, current, values) {
  var labels = [], i;
  for (i = 0; i < values.length; i++) labels.push(sgn(values[i]) + " dB" + (values[i] === current ? "  (jetzt)" : ""));
  var c = choose(labels);
  return c < 0 ? current : values[c];
}

// Returns true if something changed (the running conversion then has to be restarted).
function soundMenu() {
  var changed = false;
  while (true) {
    var labels = [
      "Preset: " + PRESET_NAMES[PRESETS.indexOf(cfg.preset)],
      "Bass: " + sgn(cfg.bass) + " dB",
      "Treble: " + sgn(cfg.treble) + " dB",
      "Volume: " + sgn(cfg.gain) + " dB",
      "Normalize: " + (cfg.norm ? "on" : "off"),
      "Reset all",
      "Done"
    ];
    var c = choose(labels);
    if (c < 0 || c === 6) break;
    if (c === 0) {
      var p = choose(PRESET_NAMES);
      if (p >= 0 && PRESETS[p] !== cfg.preset) { cfg.preset = PRESETS[p]; changed = true; }
    } else if (c === 1) {
      var b = pickNumber("Bass", cfg.bass, [-8, -6, -4, -2, 0, 2, 4, 6, 8, 10]);
      if (b !== cfg.bass) { cfg.bass = b; changed = true; }
    } else if (c === 2) {
      var t = pickNumber("Treble", cfg.treble, [-8, -6, -4, -2, 0, 2, 4, 6, 8, 10]);
      if (t !== cfg.treble) { cfg.treble = t; changed = true; }
    } else if (c === 3) {
      var g = pickNumber("Volume", cfg.gain, [-9, -6, -3, 0, 3, 6, 9, 12]);
      if (g !== cfg.gain) { cfg.gain = g; changed = true; }
    } else if (c === 4) {
      cfg.norm = cfg.norm ? 0 : 1; changed = true;
    } else if (c === 5) {
      cfg.preset = "flat"; cfg.bass = 0; cfg.treble = 0; cfg.gain = 0; cfg.norm = 0; changed = true;
    }
  }
  if (changed) saveCfg();
  return changed;
}

// ---- playback ---------------------------------------------------------------------------------
var queue = [], qi = 0;

function checkTrack(t) {
  if (!t.duration || t.duration <= 0) throw new Error("Livestreams are not supported");
  if (Math.ceil(t.duration / 60) > MAX_MIN) throw new Error("Too long (max " + MAX_MIN + " min)");
}

function startJob(t) {
  get("/bruce/music/prepare?u=" + urlEncode(t.url) + "&dur=" + t.duration + "&br=" + cfg.br + afQuery());
}

// Fetches the frames for [t, t+ms) of the track into a file. mode "write" or "append". Returns the byte count
// (0 = the track is over). The server waits for the converter if the audio isn't there yet; 503 = ask again.
function fetchPiece(t, startMs, ms, path, mode) {
  var tries = 0, memTries = 0;
  while (true) {
    if (typeof gc === "function") gc();                      // free the previous piece's string first
    var r = fetchAny("/bruce/music/chunk?id=" + t.id + "&t=" + startMs + "&ms=" + ms,
      { method: "GET", save: { fs: "sd", path: path, mode: mode } });
    if (r && r.status === 503 && tries < 3) { tries++; rm(sd(path)); delay(800); continue; }
    if (!r || r.status === undefined) {                      // the interpreter ran out of memory building the answer
      rm(sd(path));
      if (memTries < 2) { memTries++; delay(300); continue; }
      throw new Error("Out of memory in the script (HTTP answer broken)");
    }
    if (!r.ok) { rm(sd(path)); throw new Error("Server: HTTP " + r.status); }
    if (!r.saved) { rm(sd(path)); throw new Error("SD card: write failed"); }
    return r.length;
  }
}

function pieceMs(bytes) { return Math.floor(bytes * 8 / cfg.br); }   // cfg.br kbit/s = cfg.br*125 bytes/s

// The track is loaded as many small files (PIECE_MS each, cut on MP3 frames, so they join without a gap), because
// the JS heap only holds one small piece at a time. Playing the files one after another lets the progress bar move
// and makes seeking instant: a seek is just "start at another file". Returns the number of pieces, -1 if
// cancelled with Esc.
function pieceFile(k) { return CACHE + "/p" + k + ".mp3"; }

function loadPieces(t, sizes) {
  var total = t.duration * 1000, k = 0;
  clearCache();
  while (k * PIECE_MS < total) {
    screen("Loading ...", t.title, "Esc = cancel", Math.floor(100 * k * PIECE_MS / total));
    var tf = nowMs();
    var bytes = fetchPiece(t, k * PIECE_MS, PIECE_MS, pieceFile(k), "write");
    if (k % 5 === 0) trace("piece " + k + ": " + bytes + " B in " + (nowMs() - tf) + " ms");
    if (!(bytes > 0)) break;                                  // the track is over
    sizes[k] = bytes;
    k++;
    if (cancelled()) { clearCache(); return -1; }
  }
  return k;
}

// After a key press stopped the sound: turn = scrub backward / forward by one piece, press = play from there,
// back = menu (next / previous track, sound, stop). Returns {act, k}.
function seekScreen(t, k, n, total) {
  var drain = 0;
  while (drain < 6) { keyboard.getNextPress(); keyboard.getPrevPress(); keyboard.getSelPress(); keyboard.getEscPress(); delay(25); drain++; }
  var dirty = true;
  while (true) {
    if (dirty) { nowPlaying(t, k * PIECE_MS, queue.length, total, "turn = seek   press = play   back = menu"); dirty = false; }
    if (keyboard.getNextPress()) { if (k < n - 1) k++; dirty = true; }
    else if (keyboard.getPrevPress()) { if (k > 0) k--; dirty = true; }
    else if (keyboard.getSelPress()) return { act: "play", k: k };
    else if (keyboard.getEscPress()) {
      var c = choose(["Continue", "Next track", "Previous track", "Sound / EQ", "Stop"], "Paused " + fmtDur(Math.floor(k * PIECE_MS / 1000)));
      if (c === 1) return { act: "next", k: k };
      if (c === 2) return { act: "prev", k: k };
      if (c === 3) return { act: "eq", k: k };
      if (c === 4) return { act: "stop", k: k };
      return { act: "play", k: k };
    }
    delay(25);
  }
}

function playLive(t, nextTrack) {
  try { return playLiveInner(t, nextTrack); }
  finally { clearCache(); }                                  // the temp files go away however the track ends (error, Esc, stop)
}

// Loads the whole track, then plays it piece by piece. Returns "done", "next", "prev" or "stop".
function playLiveInner(t, nextTrack) {
  checkTrack(t);
  storage.mkdir(sd(FOLDER));
  storage.mkdir(sd(CACHE));
  var total = t.duration * 1000, sizes = [], k = 0, prefetched = false;
  screen("Starting ...", t.title, t.uploader, -1);
  startJob(t);
  var n = loadPieces(t, sizes);
  if (n < 0) return "stop";
  if (n === 0) throw new Error("No audio received");
  while (k < n) {
    if (!prefetched && nextTrack) {                           // let the server convert the next track while this one plays
      prefetched = true;
      try { checkTrack(nextTrack); get("/bruce/music/prepare?u=" + urlEncode(nextTrack.url) + "&dur=" + nextTrack.duration + "&br=" + cfg.br + afQuery()); } catch (err8) { /* not critical */ }
    }
    nowPlaying(t, k * PIECE_MS, queue.length, total, "");
    var expect = pieceMs(sizes[k]), t0 = nowMs();
    var okPlay = audio.playFile(pieceFile(k));                // blocks until the end of the piece or a key press
    var played = nowMs() - t0;
    if (okPlay === false) throw new Error("Bruce could not play the file (sound off?)");
    if (played >= expect - 1500) { k++; continue; }           // played to the end: next piece
    trace("key stop at piece " + k + " after " + played + " of " + expect);
    var m = seekScreen(t, played > expect / 2 ? Math.min(k + 1, n - 1) : k, n, total);
    if (m.act === "stop") return "stop";
    if (m.act === "next") return "next";
    if (m.act === "prev") return "prev";
    k = m.k;
    if (m.act === "eq" && soundMenu()) {                      // other EQ: the server converts again, load the pieces again
      startJob(t);
      n = loadPieces(t, sizes);
      if (n < 0) return "stop";
      if (k >= n) k = n - 1;
      if (k < 0) k = 0;
    }
  }
  return "done";
}

function playQueue(list, idx) {
  queue = list; qi = idx;
  while (qi >= 0 && qi < queue.length) {
    var next = null;
    if (qi + 1 < queue.length) next = queue[qi + 1];
    var res;
    try { res = playLive(queue[qi], next); }
    catch (err9) {
      fail(errText(err9));
      if (choose(["Next track", "Stop"]) !== 0) return;
      res = "next";
    }
    if (res === "stop") return;
    if (res === "prev") qi = Math.max(0, qi - 1);
    else if (cfg.repeat === 2) { /* repeat one: same index */ }
    else if (cfg.shuffle && queue.length > 1) { var j = qi; while (j === qi) j = Math.floor(Math.random() * queue.length); qi = j; }
    else {
      qi++;
      if (qi >= queue.length && cfg.repeat === 1) qi = 0;
    }
  }
}

// ---- downloads ---------------------------------------------------------------------------------
function trackFile(id) { return FOLDER + "/" + id + ".mp3"; }

function downloadTrack(t) {
  checkTrack(t);
  var sp = storage.spaceSDCard();
  if (!sp) throw new Error("No SD card found");
  if (sp.free && sp.free < t.duration * cfg.br * 125 * 1.2) throw new Error("Not enough space on the SD card");
  storage.mkdir(sd(FOLDER));
  var path = trackFile(t.id);
  if (fileSize(path) > 0) { dialog.info("Already downloaded", true); return path; }
  startJob(t);
  rm(sd(path));
  var pos = 0, total = t.duration * 1000, label = cut(ascii(t.title), 26);
  while (pos < total) {
    screen("Downloading", label, "Esc = cancel", Math.floor(100 * pos / total));
    var bytes = fetchPiece(t, pos, NEXT_MS, path, pos === 0 ? "write" : "append");
    if (!(bytes > 0)) break;
    pos += NEXT_MS;
    if (cancelled()) { rm(sd(path)); throw new Error("cancelled"); }
  }
  if (fileSize(path) < 1000) { rm(sd(path)); throw new Error("File incomplete"); }
  writeText(FOLDER + "/" + t.id + ".txt", ascii(t.title) + "\n" + ascii(t.uploader) + "\n" + t.duration + "\n" + t.url);
  try { get("/bruce/music/release?id=" + t.id); } catch (err10) { /* best effort */ }
  dialog.success("Saved to " + FOLDER, true);
  return path;
}

function clearCache() {
  var e = listDir(CACHE);
  for (var i = 0; i < e.length; i++) rm(sd(CACHE + "/" + e[i].name));
}

function savedTracks() {
  var items = [], e = listDir(FOLDER), i;
  for (i = 0; i < e.length; i++) {
    var n = e[i].name;
    if (n && n.length > 4 && n.substring(n.length - 4) === ".mp3") {
      var id = n.substring(0, n.length - 4), lines = readText(FOLDER + "/" + id + ".txt").split("\n");
      items.push({ id: id, title: lines[0] || id, uploader: lines[1] || "", duration: parseInt(lines[2], 10) || 0, size: e[i].size, file: FOLDER + "/" + n });
    }
  }
  return items;
}

function playSaved(it) {                // a downloaded file plays as one piece (a key press stops it for good)
  screen("Playing", it.title, "any key = stop", 100);
  audio.playFile(it.file);
}

function downloads() {
  while (true) {
    var items = savedTracks(), labels = [], i;
    if (items.length === 0) { dialog.info("No downloads yet in " + FOLDER, true); return; }
    for (i = 0; i < items.length; i++) labels.push((i + 1) + ". " + cut(ascii(items[i].title), 34) + " (" + Math.max(1, Math.round(items[i].size / 1048576)) + " MB)");
    labels.push("Play all");
    labels.push("<< Back");
    var c = choose(labels);
    if (c < 0 || c === labels.length - 1) return;
    try {
      if (c === labels.length - 2) { for (i = 0; i < items.length; i++) { var before = Date.now(); playSaved(items[i]); if (Date.now() - before < 3000) break; } continue; }
      var it = items[c], a = choose(["Play", "Add to queue", "Delete", "Back"]);
      if (a === 0) playSaved(it);
      else if (a === 1) { queue.push({ id: it.id, url: readText(FOLDER + "/" + it.id + ".txt").split("\n")[3] || "", title: it.title, uploader: it.uploader, duration: it.duration, src: "dl" }); dialog.info("In the queue", true); }
      else if (a === 2) { rm(sd(it.file)); rm(sd(FOLDER + "/" + it.id + ".txt")); }
    } catch (err11) { fail(errText(err11)); }
  }
}

// ---- search ------------------------------------------------------------------------------------
var SRC_NAMES = { all: "SoundCloud + YouTube", sc: "SoundCloud", yt: "YouTube" };
var MIN_STEPS = [0, 60, 120, 180];

function trackLabel(list, i) {
  var it = list[i], tag = it.src === "sc" ? "SC" : (it.src === "yt" ? "YT" : "--");
  return (i + 1) + ". " + tag + " " + fmtDur(it.duration) + " " + cut(ascii(it.title), 20) + " - " + cut(ascii(it.uploader), 9);
}

function toTrack(it) { return { id: it.id, url: it.url, title: it.title, uploader: it.uploader, duration: it.duration, src: it.src }; }

function trackMenu(list, idx) {
  var t = list[idx];
  while (true) {
    var a = choose(["Play", "Play all from here", "Add to queue", "Download", "Back"]);
    try {
      if (a === 0) playQueue([toTrack(t)], 0);
      else if (a === 1) { var rest = []; for (var i = idx; i < list.length; i++) rest.push(toTrack(list[i])); playQueue(rest, 0); }
      else if (a === 2) { queue.push(toTrack(t)); dialog.info("In the queue (" + queue.length + ")", true); }
      else if (a === 3) downloadTrack(toTrack(t));
      else return;
    } catch (err12) { fail(errText(err12)); }
  }
}

function filterMenu() {
  while (true) {
    var c = choose([
      "Quelle: " + SRC_NAMES[cfg.src],
      "Hide remix/cover/slowed: " + (cfg.clean ? "on" : "off"),
      "Minimum length: " + (cfg.minDur ? cfg.minDur + " s" : "none"),
      "Sort: " + (cfg.sort === "dur" ? "by length" : "relevance"),
      "Done"
    ]);
    if (c < 0 || c === 4) break;
    if (c === 0) cfg.src = cfg.src === "all" ? "sc" : (cfg.src === "sc" ? "yt" : "all");
    else if (c === 1) cfg.clean = cfg.clean ? 0 : 1;
    else if (c === 2) cfg.minDur = MIN_STEPS[(MIN_STEPS.indexOf(cfg.minDur) + 1) % MIN_STEPS.length];
    else if (c === 3) cfg.sort = cfg.sort === "dur" ? "rel" : "dur";
  }
  saveCfg();
}

function searchPath(q, page) {
  return "/bruce/music/search?src=" + cfg.src + "&q=" + urlEncode(q) + "&n=12&page=" + page +
    (cfg.minDur ? "&min=" + cfg.minDur : "") + (cfg.clean ? "&clean=1" : "") + "&sort=" + cfg.sort;
}

// A results list with paging and filters. fetchPage(page) returns an array, page 1 first.
function showResults(title, fetchPage) {
  var list = [], page = 1, more = true;
  screen("Searching ...", title, "", -1);
  list = fetchPage(1);
  if (!list || list.length === 0) { dialog.info("No results", true); return; }
  while (true) {
    var labels = [], i;
    for (i = 0; i < list.length; i++) labels.push(trackLabel(list, i));
    labels.push("Load more results");
    labels.push("Filters / source");
    labels.push("<< Back");
    var c = choose(labels, title);
    if (c < 0 || c === labels.length - 1) return;
    try {
      if (c === labels.length - 3) {
        page++;
        var next = fetchPage(page);
        if (!next || next.length === 0) dialog.info("No more results", true);
        else for (i = 0; i < next.length; i++) list.push(next[i]);
      } else if (c === labels.length - 2) {
        filterMenu();
        page = 1;
        screen("Searching ...", title, "", -1);
        list = fetchPage(1);
        if (!list || list.length === 0) { dialog.info("No results", true); return; }
      } else {
        trackMenu(list, c);
      }
    } catch (err13) { fail(errText(err13)); }
  }
}

function search() {
  if (!ensureWifi()) { fail(WIFI_HINT); return; }
  var q = "";
  if (history.length > 0) {
    var labels = ["New search ..."], i;
    for (i = 0; i < history.length; i++) labels.push("History: " + cut(ascii(history[i]), 30));
    labels.push("<< Back");
    var c = choose(labels);
    if (c < 0 || c === labels.length - 1) return;
    if (c > 0) q = history[c - 1];
  }
  if (!q) {
    // keyboard(initialText, maxLength, title): Bruce passes the first argument as the text already in the field
    q = keyboard.keyboard("", 60, "Search (" + SRC_NAMES[cfg.src] + ")");
    if (!q) return;
  }
  addHistory(q);
  showResults("\"" + cut(q, 18) + "\"", function (page) { return get(searchPath(q, page)); });
}

var GENRES = ["worldwide", "hiphop", "edm", "house", "techno", "electronic", "pop", "rock"];
var GENRE_NAMES = ["Worldwide", "Hip-Hop", "EDM", "House", "Techno", "Electronic", "Pop", "Rock"];

function trends() {
  if (!ensureWifi()) { fail(WIFI_HINT); return; }
  var c = choose(GENRE_NAMES.concat(["<< Back"]));
  if (c < 0 || c >= GENRES.length) return;
  showResults("Trends " + GENRE_NAMES[c], function (page) {
    return page === 1 ? get("/bruce/music/trending?genre=" + GENRES[c] + "&n=25") : [];
  });
}

function showQueue() {
  while (true) {
    if (queue.length === 0) { dialog.info("The queue is empty", true); return; }
    var labels = [], i;
    for (i = 0; i < queue.length; i++) labels.push((i + 1) + ". " + (i === qi ? "> " : "") + cut(ascii(queue[i].title), 30));
    labels.push("Play from no. 1");
    labels.push("Clear");
    labels.push("<< Back");
    var c = choose(labels);
    if (c < 0 || c === labels.length - 1) return;
    if (c === labels.length - 2) { queue = []; qi = 0; return; }
    try { playQueue(queue.slice(0), c === labels.length - 3 ? 0 : c); } catch (err14) { fail(errText(err14)); }
  }
}

function settingsMenu() {
  while (true) {
    var c = choose([
      "Quality: " + cfg.br + " kbit/s (lower = fewer pauses)",
      "Shuffle: " + (cfg.shuffle ? "on" : "off"),
      "Repeat: " + (cfg.repeat === 0 ? "off" : (cfg.repeat === 1 ? "all" : "one track")),
      "Change server",
      "Back"
    ]);
    if (c === 0) cfg.br = cfg.br === 48 ? 64 : (cfg.br === 64 ? 96 : 48);   // lower = shorter pauses between pieces
    else if (c === 1) cfg.shuffle = cfg.shuffle ? 0 : 1;
    else if (c === 2) cfg.repeat = (cfg.repeat + 1) % 3;
    else if (c === 3) {
      var v = keyboard.keyboard(customServer() || SERVER_HTTP, 200, "Server address");
      if (v) { writeText(SERVER_FILE, v.replace(/\s+/g, "")); activeBase = ""; dialog.success("Saved", true); }
    } else break;
    saveCfg();
  }
}

// Tries what the script needs one by one and lists what works: for finding out on the device which step fails.
function lastRun() {
  var t = readText(FOLDER + "/trace.txt");
  if (!t) { dialog.info("No log yet", true); return; }
  var lines = t.split("\n");
  dialog.viewText(lines.slice(Math.max(0, lines.length - 25)).join("\n"), "Last run");
}

function diagnose() {
  var lines = [], t;
  function ok(name, detail) { lines.push("OK    " + name + (detail ? ": " + detail : "")); }
  function bad(name, e) { lines.push("MISSING " + name + ": " + ascii(errText(e))); }
  function probe(name, url) {
    try {
      var pr = wifi.httpFetch(url, { method: "GET" });
      lines.push((pr && pr.status > 0 ? "REACHED " : "MISSING    ") + name + ": HTTP " + (pr ? pr.status : "?"));
    } catch (eP) {
      lines.push("MISSING    " + name + ": " + ascii(errText(eP)));
    }
  }
  try { ok("WLAN", wifi.connected() ? "connected" : "not connected"); } catch (e1) { bad("WLAN", e1); }
  probe("LAN " + SERVER_LAN.replace("http://", ""), SERVER_LAN + "/health");
  probe("public http", SERVER_HTTP + "/health");
  probe("https Port 443", SERVER.replace(/\/tembed\/.*/, "") + "/health");
  try { t = get("/health"); ok("Server /health", JSON.stringify(t) + " via " + activeBase.replace(/\/(tembed|b)\/.*/, "")); } catch (e2) { bad("Server /health", e2); }
  try { t = get(searchPath("test", 1)); ok("Search (both)", t.length + " results"); } catch (e3) { bad("Search", e3); }
  try {
    t = storage.spaceSDCard();
    if (!t) throw new Error("no SD card");
    ok("SD-Karte", Math.floor((t.free || 0) / 1048576) + " MB free");
    storage.mkdir(sd(FOLDER));
    var p = FOLDER + "/_test.txt";
    rm(sd(p));
    var r = fetchAny("/health", { method: "GET", save: { fs: "sd", path: p, mode: "write" } });
    var size = fileSize(p);
    rm(sd(p));
    if (r && r.saved && size > 0) ok("Save response to file", size + " Bytes"); else throw new Error("saved=" + (r && r.saved) + ", size " + size);
  } catch (e5) { bad("SD / saving", e5); }
  try { ok("audio.playFile", typeof audio.playFile === "function" ? "present" : "FEHLT"); } catch (e6) { bad("audio.playFile", e6); }
  var text = lines.join("\n");
  try { dialog.viewText(text, "Diagnostics"); } catch (e7) { dialog.info(text, true); }
}

// Plays 6 s of the first search hit and reports how long Bruce really played it: tells whether playFile
// returns early (a key press, a decoder stop) or on time.
function audioTest() {
  if (!ensureWifi()) { fail(WIFI_HINT); return; }
  var list = get(searchPath("test", 1));
  if (!list || list.length === 0) throw new Error("no test track");
  var t = toTrack(list[0]), path = CACHE + "/test.mp3";
  storage.mkdir(sd(FOLDER)); storage.mkdir(sd(CACHE));
  startJob(t);
  screen("Audio test", t.title, "do not press anything", -1);
  var bytes = fetchPiece(t, 0, 6000, path, "write"), expect = pieceMs(bytes), t0 = nowMs();
  var r = audio.playFile(path), played = nowMs() - t0;
  clearCache();
  dialog.viewText("playFile returned: " + r + "\nplayed: " + played + " ms\nexpected: " + expect + " ms\nbytes: " + bytes +
    "\n\nIf played is far below expected without a key press, the decoder or output stops early.", "Audio test");
}

function main() {
  if (bases().length === 0) {                                  // first run without a built-in server: ask once
    var v0 = keyboard.keyboard("http://", 200, "Server address");
    if (v0 && v0.length > 8) writeText(SERVER_FILE, v0.replace(/\s+/g, ""));
  }
  if (!ensureWifi()) dialog.error(WIFI_HINT, true);          // downloads still play offline, so carry on
  if (fileSize(FOLDER + "/trace.txt") > 4000) rm(sd(FOLDER + "/trace.txt"));   // keep the last run (crash clue)
  loadCfg();
  loadHistory();
  clearCache();
  while (true) {
    var c = choose(["Search SoundCloud", "Search YouTube", "Search both", "Trends", "My downloads", "Queue (" + queue.length + ")", "Sound / EQ", "Settings", "Diagnostics", "Audio test", "Last run", "Quit"], "Musicstreaming");
    try {
      if (c >= 0 && c <= 2) { cfg.src = c === 0 ? "sc" : (c === 1 ? "yt" : "all"); saveCfg(); search(); }
      else if (c === 3) trends();
      else if (c === 4) downloads();
      else if (c === 5) showQueue();
      else if (c === 6) soundMenu();
      else if (c === 7) settingsMenu();
      else if (c === 8) diagnose();
      else if (c === 9) audioTest();
      else if (c === 10) lastRun();
      else { clearCache(); return; }
    } catch (err15) {
      clearCache();
      fail(errText(err15));
    }
  }
}

try { main(); } catch (err16) { fail(errText(err16)); }
