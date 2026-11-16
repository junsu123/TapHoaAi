import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import S from "../settings.js";

test("9:16 sizes: physical pixels on scaled displays, fitting a screen", () => {
  assert.deepEqual(S.contentSize(1080, 1), { width: 1080, height: 1920 });
  assert.deepEqual(S.contentSize(1080, 1.5), { width: 720, height: 1280 }); // 150 % Windows scaling
  assert.deepEqual(S.fitInto({ width: 1920, height: 1040 }, { width: 1080, height: 1920 }), { width: 585, height: 1040 });
  assert.deepEqual(S.fitInto({ width: 400, height: 2000 }, { width: 1080, height: 1920 }), { width: 400, height: 711 });
});

test("settings are cleaned and kept between runs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chibi-"));
  const file = path.join(dir, "config.json");
  assert.equal(S.load(file).server, "http://127.0.0.1:8686"); // no file yet: defaults
  S.save(file, { server: "http://192.168.1.5:9090/dashboard/game", size: 99999, quality: "ultra", token: "  abc  " });
  const c = S.load(file);
  assert.equal(c.server, "http://192.168.1.5:9090");
  assert.equal(c.size, 2160);
  assert.equal(c.quality, "");
  assert.equal(c.token, "abc");
  assert.equal(S.sanitize({ server: "javascript:alert(1)" }).server, "http://127.0.0.1:8686");
  fs.writeFileSync(file, "{broken");
  assert.equal(S.load(file).size, 0);
});

test("game address: always the primary renderer, token and quality when set", () => {
  assert.equal(S.gameUrl(S.sanitize({})), "http://127.0.0.1:8686/game/live?role=primary&app=desktop");
  const u = new URL(S.gameUrl(S.sanitize({ server: "http://10.0.0.2:8686", token: "t k", quality: "low" })));
  assert.equal(u.searchParams.get("token"), "t k");
  assert.equal(u.searchParams.get("quality"), "low");
});

test("command line options", () => {
  const c = S.fromArgs(["--server=http://127.0.0.1:9000", "--size=1080", "--frameless", "--on-top", "--no-server", "x"], S.sanitize({}));
  assert.equal(c.server, "http://127.0.0.1:9000");
  assert.equal(c.size, 1080);
  assert.ok(c.frameless && c.alwaysOnTop && !c.startServer);
});

test("finds the software folder and its Python to start the server", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chibi-root-"));
  fs.mkdirSync(path.join(root, "backend", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "backend", "app", "__main__.py"), "");
  fs.mkdirSync(path.join(root, "backend", ".venv", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "backend", ".venv", "Scripts", "python.exe"), "");
  const appDir = path.join(root, "desktop");
  assert.equal(S.findServerDir(S.sanitize({}), appDir, os.tmpdir()), root);
  const c = S.serverCommand(root, 8686);
  assert.ok(c.cmd.endsWith("python.exe"));
  assert.deepEqual(c.args, ["-m", "app", "--port", "8686"]);
  assert.equal(S.serverCommand("", 8686), null);
});
