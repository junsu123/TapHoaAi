// Chibi Live Game — the 9:16 game as a Windows app (instead of a browser tab / OBS Browser Source).
// Opens the game page of the local Chibi Live Shop server in its own window that always keeps
// the 9:16 shape, starts the server if it is not running, and keeps rendering at full speed even
// when the window is covered or minimised (OBS Window Capture needs that).

const { app, BrowserWindow, Menu, dialog, ipcMain, net, powerSaveBlocker, screen, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const path = require("node:path");
const S = require("./settings");

// ---- render at full speed, always (no throttling when covered or in the background)
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required"); // the voice plays without a click
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

if (process.env.CHIBI_DESKTOP_USERDATA) app.setPath("userData", process.env.CHIBI_DESKTOP_USERDATA);
const CONFIG = () => path.join(app.getPath("userData"), "config.json");

let cfg = S.DEFAULTS;
let win = null;
let settingsWin = null;
let serverProc = null;
let serverStartedByUs = false;
let waitTimer = null;
let state = { phase: "starting", message: "Đang khởi động…" };

if (!app.requestSingleInstanceLock()) {
  // one game window only: it is the "primary" that confirms every Chibi command
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start);
}

// options given on the command line (--no-server, --chibi-debug) are for this run only
let runOnly = {};
const saveCfg = () => S.save(CONFIG(), { ...cfg, ...runOnly });

function start() {
  const fromFile = S.load(CONFIG());
  cfg = S.fromArgs(process.argv.slice(1), fromFile);
  runOnly = { startServer: fromFile.startServer, debug: fromFile.debug };
  powerSaveBlocker.start("prevent-display-sleep");
  createWindow();
  connect();
  const report = process.argv.find((a) => a.startsWith("--chibi-report="));
  if (report) setTimeout(() => writeReport(report.split("=").slice(1).join("=")), 8000);
}

/** Test hook (CI on Windows): the window's real size and the size of what it shows, then quit. */
async function writeReport(file) {
  const display = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  let capture = null;
  try {
    const img = await win.webContents.capturePage();
    capture = img.getSize();
  } catch (e) {
    capture = { error: String(e) };
  }
  const out = {
    platform: process.platform,
    scaleFactor: display.scaleFactor,
    workArea: physicalOf(display.workAreaSize, display),
    window: physicalSize(),
    contentDip: win?.getContentSize(),
    bounds: win?.getBounds(),
    capture,
    quality: cfg.quality,
    url: win?.webContents.getURL(),
  };
  require("node:fs").writeFileSync(file, JSON.stringify(out, null, 2));
  app.quit();
}

// ------------------------------------------------------------------ window
function targetDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => d.id === cfg.display) ?? screen.getPrimaryDisplay();
}

function wantedSize(display) {
  const area = display.workAreaSize;
  if (!cfg.size) {
    // as big as fits: 90 % of the screen height, the whole picture visible
    return S.fitInto({ width: Math.round(area.width * 0.95), height: Math.round(area.height * 0.9) }, { width: 9999, height: 99999 });
  }
  return S.contentSize(cfg.size, display.scaleFactor);
}

function createWindow() {
  const display = targetDisplay();
  const size = wantedSize(display);
  const pos = cfg.bounds && screen.getDisplayMatching({ ...cfg.bounds, ...size }).id === display.id ? cfg.bounds : null;
  const w = new BrowserWindow({
    ...size,
    ...(pos ? { x: pos.x, y: pos.y } : {}),
    useContentSize: true,
    title: "Chibi Live Game",
    icon: path.join(__dirname, "build", "icon.png"),
    backgroundColor: "#1a1016",
    frame: !cfg.frameless,
    alwaysOnTop: cfg.alwaysOnTop,
    autoHideMenuBar: true,
    enableLargerThanScreen: true, // 1080 × 1920 on a landscape Full HD monitor
    maxWidth: 4320,
    maxHeight: 7680,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win = w;
  win.setAspectRatio(9 / 16);
  // Windows keeps a window within about the screen's size unless a maximum is set: allow up to 4K tall
  win.setMaximumSize(4320, 7680);
  if (S.sticksOut(physicalOf(size, display), physicalOf(display.workAreaSize, display))) {
    win.setContentSize(size.width, size.height); // again, now that the maximum allows it
    placeTopVisible(display);
  } else if (!pos) win.center();
  win.once("ready-to-show", () => {
    win.show();
    if (cfg.fullscreen) win.setFullScreen(true);
  });
  win.setMenu(buildMenu());
  win.setMenuBarVisibility(false);
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && shortcut(input)) e.preventDefault();
  });
  win.webContents.on("context-menu", () => buildMenu().popup({ window: win }));
  // only the Chibi server is shown inside; other links open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(cfg.server) && !url.startsWith("file:")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && url.startsWith(cfg.server)) waitForServer("Mất kết nối tới máy chủ — đang thử lại…");
  });
  win.webContents.on("render-process-gone", () => waitForServer("Trang game gặp sự cố — đang mở lại…"));
  let saveT = null;
  let manualResize = false;
  const remember = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      if (!win || win.isFullScreen()) return;
      const b = win.getContentBounds();
      const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
      cfg = { ...cfg, bounds: { x: win.getBounds().x, y: win.getBounds().y }, display: screen.getDisplayMatching(win.getBounds()).id };
      if (manualResize) cfg.size = Math.round(b.width * scale);
      manualResize = false;
      saveCfg();
      updateTitle();
    }, 400);
  };
  win.on("will-resize", () => (manualResize = true));
  win.on("resize", remember);
  win.on("move", remember);
  w.on("closed", () => {
    if (win === w) win = null;
  });
  updateTitle();
}

const physicalOf = (sz, display) => ({ width: Math.round(sz.width * display.scaleFactor), height: Math.round(sz.height * display.scaleFactor) });

/** A window taller than the screen: its top (title bar, start of the picture) stays on screen. */
function placeTopVisible(display) {
  if (!win) return;
  const b = win.getBounds();
  const wa = display.workArea;
  win.setPosition(wa.x + Math.max(0, Math.round((wa.width - b.width) / 2)), wa.y);
}

function physicalSize() {
  if (!win) return { width: 0, height: 0 };
  const b = win.getContentBounds();
  const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
  return { width: Math.round(b.width * scale), height: Math.round(b.height * scale) };
}

function updateTitle() {
  if (!win) return;
  const p = physicalSize();
  const what = state.phase === "game" ? "" : ` — ${state.message}`;
  win.setTitle(`Chibi Live Game — ${p.width} × ${p.height}${what}`);
}

function setSize(widthPx) {
  if (!win) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  cfg = { ...cfg, size: widthPx };
  const display = screen.getDisplayMatching(win.getBounds());
  const s = wantedSize(display);
  win.setContentSize(s.width, s.height);
  if (S.sticksOut(physicalOf(s, display), physicalOf(display.workAreaSize, display))) placeTopVisible(display);
  saveCfg();
  setTimeout(updateTitle, 50);
}

/** "Nét nhất cho LIVE": exactly the 1080 × 1920 LIVE frame, drawn at the sharpest quality. */
function sharpLive() {
  const qualityChanged = cfg.quality !== "";
  cfg = S.sharpLive(cfg);
  if (win?.isFullScreen()) win.setFullScreen(false);
  setSize(1080);
  if (qualityChanged && state.phase === "game") win?.loadURL(S.gameUrl(cfg));
  win?.setMenu(buildMenu());
}

function toggle(key) {
  cfg = { ...cfg, [key]: !cfg[key] };
  saveCfg();
  if (key === "alwaysOnTop") win?.setAlwaysOnTop(cfg.alwaysOnTop);
  if (key === "fullscreen") win?.setFullScreen(cfg.fullscreen);
  if (key === "frameless") {
    // a window frame cannot be removed from an open window: make a new one
    const old = win;
    createWindow();
    connect();
    old?.destroy();
  }
  win?.setMenu(buildMenu());
}

function moveToNextDisplay() {
  const all = screen.getAllDisplays();
  if (all.length < 2 || !win) return;
  const cur = screen.getDisplayMatching(win.getBounds());
  const next = all[(all.findIndex((d) => d.id === cur.id) + 1) % all.length];
  cfg = { ...cfg, display: next.id, bounds: null };
  const s = wantedSize(next);
  win.setContentBounds({ x: next.workArea.x + Math.round((next.workArea.width - s.width) / 2), y: next.workArea.y + 20, ...s });
  saveCfg();
}

function shortcut(i) {
  const ctrl = i.control || i.meta;
  if (i.key === "F11") toggle("fullscreen");
  else if (i.key === "Escape" && win?.isFullScreen()) toggle("fullscreen");
  else if (i.key === "F5" || (ctrl && i.key.toLowerCase() === "r")) reload();
  else if (ctrl && i.key === "0") setSize(0);
  else if (ctrl && i.key === "1") setSize(540);
  else if (ctrl && i.key === "2") setSize(720);
  else if (ctrl && i.key === "3") setSize(1080);
  else if (ctrl && i.key.toLowerCase() === "l") sharpLive();
  else if (ctrl && i.key.toLowerCase() === "t") toggle("alwaysOnTop");
  else if (ctrl && i.key.toLowerCase() === "b") toggle("frameless");
  else if (ctrl && i.key.toLowerCase() === "m") moveToNextDisplay();
  else if (ctrl && i.key.toLowerCase() === "d") shell.openExternal(`${cfg.server}/dashboard`);
  else if (ctrl && i.key === ",") openSettings();
  else if (ctrl && i.shift && i.key.toLowerCase() === "i") win?.webContents.openDevTools({ mode: "detach" });
  else return false;
  return true;
}

function buildMenu() {
  const sizes = S.PRESETS.map((p, k) => ({
    label: p.label,
    type: "radio",
    checked: cfg.size === p.width,
    accelerator: `CmdOrCtrl+${k === 0 ? 0 : k}`,
    click: () => setSize(p.width),
  }));
  return Menu.buildFromTemplate([
    { label: "Nét nhất cho LIVE (1080 × 1920)", accelerator: "CmdOrCtrl+L", click: sharpLive },
    { label: "Kích thước khung 9:16", submenu: sizes },
    { label: "Toàn màn hình", type: "checkbox", checked: !!win?.isFullScreen(), accelerator: "F11", click: () => toggle("fullscreen") },
    { label: "Luôn nằm trên cùng", type: "checkbox", checked: cfg.alwaysOnTop, accelerator: "CmdOrCtrl+T", click: () => toggle("alwaysOnTop") },
    { label: "Ẩn viền cửa sổ (hình sạch cho OBS)", type: "checkbox", checked: cfg.frameless, accelerator: "CmdOrCtrl+B", click: () => toggle("frameless") },
    { label: "Chuyển sang màn hình khác", accelerator: "CmdOrCtrl+M", click: moveToNextDisplay, enabled: screen.getAllDisplays().length > 1 },
    { type: "separator" },
    { label: "Tải lại game", accelerator: "F5", click: reload },
    { label: "Mở bảng điều khiển", accelerator: "CmdOrCtrl+D", click: () => shell.openExternal(`${cfg.server}/dashboard`) },
    { label: "Cài đặt…", accelerator: "CmdOrCtrl+,", click: openSettings },
    { type: "separator" },
    { label: "Thoát", click: () => app.quit() },
  ]);
}

// ------------------------------------------------------------------ server
async function serverUp() {
  try {
    const r = await net.fetch(`${cfg.server}/api/v1/auth/setup`, { cache: "no-store" });
    return r.status < 500;
  } catch {
    return false;
  }
}

function showWaiting(message) {
  state = { phase: "waiting", message };
  updateTitle();
  if (!win) return;
  const q = new URLSearchParams({ msg: message, server: cfg.server });
  const url = `file://${path.join(__dirname, "pages", "waiting.html")}?${q}`;
  if (!win.webContents.getURL().startsWith("file:")) win.loadURL(url);
  else win.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(message)})`).catch(() => undefined);
}

function startServer() {
  if (serverProc || !cfg.startServer) return false;
  const dir = S.findServerDir(cfg, app.isPackaged ? path.dirname(process.execPath) : __dirname, process.cwd());
  const port = Number(new URL(cfg.server).port || 80);
  const local = ["127.0.0.1", "localhost"].includes(new URL(cfg.server).hostname);
  const c = local ? S.serverCommand(dir, port) : null;
  if (!c) return false;
  serverProc = spawn(c.cmd, c.args, { cwd: c.cwd, windowsHide: true, stdio: "ignore" });
  serverStartedByUs = true;
  serverProc.on("exit", () => (serverProc = null));
  return true;
}

async function connect() {
  clearTimeout(waitTimer);
  if (await serverUp()) {
    state = { phase: "game", message: "" };
    win?.loadURL(S.gameUrl(cfg));
    updateTitle();
    return;
  }
  const started = startServer();
  waitForServer(
    started || serverProc
      ? "Đang mở máy chủ Chibi Live Shop…"
      : `Chưa thấy máy chủ ở ${cfg.server}. Hãy mở phần mềm Chibi Live Shop (scripts\\dev_windows.ps1) hoặc sửa địa chỉ trong Cài đặt.`,
  );
}

function waitForServer(message) {
  showWaiting(message);
  clearTimeout(waitTimer);
  waitTimer = setTimeout(connect, 1500);
}

function reload() {
  if (state.phase === "game") win?.webContents.reloadIgnoringCache();
  else connect();
}

function stopServer() {
  if (!serverProc || !serverStartedByUs) return;
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], () => undefined);
  else serverProc.kill();
  serverProc = null;
}

// ------------------------------------------------------------------ settings window
function openSettings() {
  if (settingsWin) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 520,
    height: 600,
    parent: win ?? undefined,
    title: "Cài đặt — Chibi Live Game",
    autoHideMenuBar: true,
    backgroundColor: "#f4f7f5",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, "pages", "settings.html"));
  settingsWin.on("closed", () => (settingsWin = null));
}

ipcMain.handle("config:get", () => ({ cfg, presets: S.PRESETS, size: physicalSize(), phase: state.phase }));
ipcMain.handle("config:save", (_e, next) => {
  const before = cfg;
  cfg = S.sanitize({ ...cfg, ...next });
  if ("startServer" in next) runOnly.startServer = cfg.startServer; // the user's own choice is kept
  saveCfg();
  if (before.server !== cfg.server || before.token !== cfg.token || before.quality !== cfg.quality) connect();
  if (before.size !== cfg.size) setSize(cfg.size);
  return cfg;
});
ipcMain.handle("config:chooseDir", async () => {
  const r = await dialog.showOpenDialog(settingsWin ?? win, { title: "Chọn thư mục phần mềm Chibi Live Shop", properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("app:state", () => ({ ...state, size: physicalSize(), server: cfg.server }));

app.on("window-all-closed", () => app.quit());
app.on("before-quit", stopServer);
