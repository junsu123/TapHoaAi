// End-to-end test of the Windows game app (run on Linux under Xvfb):
//   xvfb-run -s "-screen 0 2000x2400x24" node test/app.e2e.mjs
// Starts a fresh server, opens the app, checks the 9:16 window, the size presets, that it is
// the game's primary renderer (a viewer's comment makes a Chibi fetch the box), the waiting
// screen when there is no server, and that only one game window can run.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "..", "..");
const require = createRequire(path.join(root, "frontend", "package.json"));
const { _electron } = require("playwright");
const SHOTS = path.join(root, "desktop", "test-results");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("•", ...a);

async function waitUp(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`server not up: ${url}`);
}

async function waitFor(fn, ms = 40000, what = "condition") {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timeout: ${what}`);
}

const electronBin = path.join(here, "..", "node_modules", "electron", "dist", "electron");
const launch = (args, userData) =>
  _electron.launch({
    executablePath: electronBin,
    args: [path.join(here, ".."), ...args],
    env: { ...process.env, CHIBI_DESKTOP_USERDATA: userData },
  });

const server = spawn("bash", [path.join(root, "scripts", "e2e_server.sh")], {
  env: { ...process.env, CHIBI_PORT: String(PORT), CHIBI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "chibi-desk-")) + "/data" },
  stdio: "ignore",
});
let app;
const results = {};
try {
  await waitUp(`${BASE}/api/v1/auth/setup`);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "chibi-desk-ud-"));

  // 1) no server yet at this address: the waiting screen explains what to do
  app = await launch(["--server=http://127.0.0.1:8799", "--no-server"], userData);
  let page = await app.firstWindow();
  await page.waitForSelector("[data-testid=waiting-status]");
  await waitFor(async () => (await page.textContent("[data-testid=waiting-status]")).includes("Chưa thấy máy chủ"), 10000, "waiting text");
  await page.screenshot({ path: `${SHOTS}/DESKTOP-1-waiting.png` });
  results.waiting = await page.textContent("[data-testid=waiting-status]");
  log("waiting screen:", results.waiting);
  await app.close();
  await sleep(2000); // the single-instance lock is released

  // 2) the real server: the game, 9:16, as the primary renderer
  app = await launch([`--server=${BASE}`, "--size=540", "--no-server", "--chibi-debug"], userData);
  page = await app.firstWindow();
  await waitFor(() => page.url().includes("/game/live"), 20000, "game page");
  await page.waitForFunction(() => window.__chibiDebug?.state().layoutVersion > 0, null, { timeout: 30000 });
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  log("content size", size);
  assert.deepEqual(size, [540, 960]);
  const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  assert.match(title, /540 × 960/);

  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "chu_shop", password: "mat-khau-demo-123" }),
  });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const H = { "Content-Type": "application/json", "X-CSRF-Token": (await login.json()).csrf_token, Cookie: cookie };
  const metrics = async () => (await fetch(`${BASE}/api/v1/metrics`, { headers: H })).json();
  await waitFor(async () => (await metrics()).game_clients.primary, 10000, "primary");
  await fetch(`${BASE}/api/v1/demo/events`, { method: "POST", headers: H, body: JSON.stringify({ raw: "@khachapp: trà cà gai leo" }) });
  await page.waitForFunction(() => window.__chibiDebug.state().avatars.some((a) => a.nickname === "khachapp" && a.phase === "show"), null, { timeout: 40000 });
  await page.screenshot({ path: `${SHOTS}/DESKTOP-2-game-540x960.png` });
  const done = await waitFor(async () => {
    const s = await page.evaluate(() => window.__chibiDebug.state());
    return s.avatars.find((a) => a.nickname === "khachapp" && a.completed.length > 0);
  }, 40000, "command completed");
  results.command = { completed: done.completed.length };
  log("command completed by the app (primary renderer)");

  // 3) size presets keep 9:16 (Ctrl+2 = 720 × 1280)
  // a real key press goes through the window (like the user's keyboard)
  const press = (keyCode, modifiers = []) =>
    app.evaluate(({ BrowserWindow }, a) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: "keyDown", keyCode: a.keyCode, modifiers: a.modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode: a.keyCode, modifiers: a.modifiers });
    }, { keyCode, modifiers });
  await press("2", ["control"]);
  await sleep(1500);
  const s720 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  log("after Ctrl+2", s720);
  assert.deepEqual(s720, [720, 1280]);
  await page.screenshot({ path: `${SHOTS}/DESKTOP-3-game-720x1280.png` });
  const ratio = await page.evaluate(() => {
    const r = document.querySelector("[data-testid=game-stage]").getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  assert.ok(Math.abs(ratio.w / ratio.h - 9 / 16) < 0.01, `stage ${ratio.w}×${ratio.h}`);
  results.sizes = { first: size, ctrl2: s720, stage: ratio };

  // 4) keeps rendering when hidden behind other windows / minimised (OBS still captures it)
  const before = (await page.evaluate(() => window.__chibiDebug.fps())).length;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await sleep(4000);
  const after = (await page.evaluate(() => window.__chibiDebug.fps())).length;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  log("frames-per-second samples while hidden:", after - before);
  assert.ok(after - before >= 2, "game kept rendering while hidden");
  results.hiddenFpsSamples = after - before;

  // 5) settings are remembered (size)
  const cfg = JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8"));
  assert.equal(cfg.size, 720);

  // 6) only one game window: a second start just focuses the first
  const second = spawn(electronBin, [path.join(here, ".."), `--server=${BASE}`, "--no-server"], {
    env: { ...process.env, CHIBI_DESKTOP_USERDATA: userData },
    stdio: "ignore",
  });
  const code = await new Promise((r) => second.on("exit", r));
  log("second instance exit code", code);
  results.secondInstanceExit = code;
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

  // 7) the settings window
  await press(",", ["control"]);
  const sw = await waitFor(async () => app.windows().find((w) => w.url().endsWith("settings.html")), 10000, "settings window");
  await sw.waitForSelector("input[name=server]");
  await waitFor(async () => (await sw.inputValue("input[name=server]")) === BASE, 5000, "settings filled");
  await sw.screenshot({ path: `${SHOTS}/DESKTOP-4-settings.png` });
  fs.writeFileSync(`${SHOTS}/DESKTOP-results.json`, JSON.stringify(results, null, 2));
  console.log("DESKTOP E2E PASSED");
} finally {
  await app?.close().catch(() => undefined);
  server.kill();
  spawn("pkill", ["-f", `--port ${PORT}`]);
}
