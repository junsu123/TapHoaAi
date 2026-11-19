// Settings of the game window, kept in %APPDATA%/Chibi Live Game/config.json.
// Pure helpers (no Electron) so they can be unit-tested with node --test.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  server: "http://127.0.0.1:8686", // the Chibi Live Shop server (dashboard address without /dashboard)
  token: "", // only when the server runs on another computer (Game 3D & OBS page shows it)
  quality: "", // "", "low", "medium", "high", "ultra" ("" = automatic: starts at "ultra" = sharpest, steps down if the PC is too slow)
  size: 0, // window width in physical pixels (height = width × 16 / 9); 0 = as big as fits the screen
  alwaysOnTop: false,
  frameless: false, // no title bar: a clean picture for OBS Window Capture
  fullscreen: false,
  display: null, // id of the monitor to open on
  bounds: null, // last position {x, y}
  serverDir: "", // folder of the software (with backend\) to start the server automatically
  startServer: true,
  debug: false, // ?debug=1 on the game page (tests)
};

/** Width/height presets (physical pixels, 9:16). */
const PRESETS = [
  { width: 0, label: "Vừa màn hình" },
  { width: 540, label: "540 × 960 (nhỏ, nhẹ máy)" },
  { width: 720, label: "720 × 1280 (HD dọc)" },
  { width: 1080, label: "1080 × 1920 (Full HD dọc — đúng khung LIVE)" },
];

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return sanitize({ ...DEFAULTS, ...raw });
  } catch {
    return { ...DEFAULTS };
  }
}

function save(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sanitize(cfg), null, 2), "utf8");
}

function sanitize(c) {
  const out = { ...DEFAULTS, ...c };
  try {
    const u = new URL(String(out.server));
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
    out.server = `${u.protocol}//${u.host}`;
  } catch {
    out.server = DEFAULTS.server;
  }
  out.token = String(out.token || "").trim().slice(0, 200);
  out.quality = ["low", "medium", "high", "ultra"].includes(out.quality) ? out.quality : "";
  const w = Math.round(Number(out.size));
  out.size = !Number.isFinite(w) || w <= 0 ? 0 : Math.min(2160, Math.max(270, w));
  out.alwaysOnTop = !!out.alwaysOnTop;
  out.frameless = !!out.frameless;
  out.fullscreen = !!out.fullscreen;
  out.startServer = out.startServer !== false;
  out.debug = !!out.debug;
  out.serverDir = String(out.serverDir || "");
  return out;
}

/** Content size in device-independent pixels for a physical width on a display scale. */
function contentSize(widthPx, scaleFactor) {
  const s = scaleFactor > 0 ? scaleFactor : 1;
  const w = Math.round(widthPx / s);
  return { width: w, height: Math.round((w * 16) / 9) };
}

/** Largest 9:16 size that fits a work area (keeps the whole picture on screen). */
function fitInto(area, wanted) {
  let { width, height } = wanted;
  if (height > area.height) {
    height = area.height;
    width = Math.round((height * 9) / 16);
  }
  if (width > area.width) {
    width = area.width;
    height = Math.round((width * 16) / 9);
  }
  return { width, height };
}

/**
 * A window whose inside lost the 9:16 shape (snapped to half a screen, maximised, clamped by
 * Windows, or the frame counted in the drag): the largest 9:16 size inside it, or null when it
 * is already 9:16. A wider window would show dark bars on both sides and not fit the LIVE frame.
 */
function shapeFix(content, tolerance = 2) {
  if (!(content.width > 0 && content.height > 0)) return null;
  const fit = fitInto(content, { width: 1e6, height: 1e6 });
  if (Math.abs(fit.width - content.width) <= tolerance && Math.abs(fit.height - content.height) <= tolerance) return null;
  return fit;
}

/** The game page the window shows (always the primary renderer). */
function gameUrl(cfg) {
  const q = new URLSearchParams();
  q.set("role", "primary");
  if (cfg.token) q.set("token", cfg.token);
  if (cfg.quality) q.set("quality", cfg.quality);
  q.set("app", "desktop");
  if (cfg.debug) q.set("debug", "1");
  return `${cfg.server}/game/live?${q.toString()}`;
}

/** Where the server's Python is, given the software folder (Windows or Linux/macOS venv). */
function serverCommand(dir, port) {
  if (!dir) return null;
  const backend = path.join(dir, "backend");
  for (const py of [path.join(backend, ".venv", "Scripts", "python.exe"), path.join(backend, ".venv", "bin", "python")]) {
    if (fs.existsSync(py)) return { cmd: py, args: ["-m", "app", "--port", String(port)], cwd: backend };
  }
  return null;
}

/** Candidate software folders: the one in settings, then folders around the app. */
function findServerDir(cfg, appDir, cwd) {
  const cands = [cfg.serverDir, path.resolve(appDir, ".."), path.resolve(appDir, "..", "..", ".."), cwd, path.resolve(cwd, "..")];
  for (const d of cands) {
    if (d && fs.existsSync(path.join(d, "backend", "app", "__main__.py"))) return d;
  }
  return "";
}

/** "Nét nhất cho LIVE": the window exactly the 1080 × 1920 LIVE frame, sharpest picture (steps down only if too slow). */
function sharpLive(cfg) {
  return { ...cfg, size: 1080, quality: "", fullscreen: false };
}

/** Does a window of this physical size stick out of the screen's work area (also in physical pixels)? */
function sticksOut(physical, workAreaPhysical) {
  return physical.width > workAreaPhysical.width || physical.height > workAreaPhysical.height;
}

/** Command-line options: --server=URL --token=T --size=1080 --fullscreen --frameless --on-top --quality=low */
function fromArgs(argv, cfg) {
  const out = { ...cfg };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "server" && v) out.server = v;
    else if (k === "token" && v !== undefined) out.token = v;
    else if (k === "size" && v) out.size = Number(v);
    else if (k === "quality" && v) out.quality = v;
    else if (k === "fullscreen") out.fullscreen = true;
    else if (k === "frameless") out.frameless = true;
    else if (k === "on-top") out.alwaysOnTop = true;
    else if (k === "no-server") out.startServer = false;
    else if (k === "chibi-debug") out.debug = true;
    else if (k === "sharp-live") Object.assign(out, sharpLive(out));
  }
  return sanitize(out);
}

module.exports = { DEFAULTS, PRESETS, load, save, sanitize, contentSize, fitInto, shapeFix, gameUrl, serverCommand, findServerDir, fromArgs, sharpLive, sticksOut };
