// Playwright acceptance smoke tests against the real backend + real WebGL client.
// They read the client's own state (window.__chibiDebug) — not mocks — so a PASS means the
// browser really walked, picked, showed and returned the box (SPEC L: T03, T05, T14, T18).

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";

const SHOTS = "test-results/evidence";
fs.mkdirSync(SHOTS, { recursive: true });
const RUN = Date.now().toString(36).slice(-4);

interface DebugAvatar {
  id: string;
  nickname: string;
  state: string;
  phase: string;
  commandId: string | null;
  heldProductId: string | null;
  heldMode: string | null;
  completed: string[];
  pos: { x: number; z: number };
}
interface DebugState {
  layoutVersion: number;
  isDemo: boolean;
  camera: { mode: string; avatarId: string | null; phase: string | null };
  avatars: DebugAvatar[];
  sent: { type: string; command_id?: string; reason?: string }[];
}

async function login(request: APIRequestContext): Promise<string> {
  const r = await request.post("/api/v1/auth/login", { data: { username: "chu_shop", password: "mat-khau-demo-123" } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).csrf_token;
}

async function inject(page: Page, csrf: string, raw: string) {
  const r = await page.request.post("/api/v1/demo/events", { data: { raw }, headers: { "X-CSRF-Token": csrf } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

const state = (page: Page) => page.evaluate(() => (window as any).__chibiDebug.state() as DebugState);
const cameraShot = (page: Page) => page.evaluate(() => (window as any).__chibiDebug.camera()?.shot as string);
const avatarOf = (s: DebugState, nick: string) => s.avatars.find((a) => a.nickname === nick);

async function openGame(page: Page, quality: string | null = "medium") {
  await page.goto(`/game/live?debug=1${quality ? `&quality=${quality}` : ""}`);
  await page.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0, null, { timeout: 20_000 });
}

async function waitFor<T>(page: Page, fn: (s: DebugState) => T | undefined | null | false, timeoutMs = 40_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn(await state(page));
    if (v) return v;
    await page.waitForTimeout(150);
  }
  throw new Error("condition not reached; last state: " + JSON.stringify((await state(page)).avatars));
}

test("T03 + T14: comment → walk to KE_02 → pick TRA_CA_GAI_LEO → close-up → return", async ({ page }) => {
  const csrf = await login(page.request);
  const boxImage = page.waitForResponse((r) => r.url().includes("/media/") && r.status() === 200);
  await openGame(page);
  await boxImage; // T14: the real front-of-box photo is loaded as a texture
  const nick = `lananh${RUN}`;
  await inject(page, csrf, `@${nick}: trà cà gai leo`);

  const walking = await waitFor(page, (s) => {
    const a = avatarOf(s, nick);
    return a && a.phase === "to_stand" ? a : null;
  });
  expect(walking.commandId).toBeTruthy();
  await page.screenshot({ path: `${SHOTS}/T03-1-walking.png` });

  const showing = await waitFor(page, (s) => {
    const a = avatarOf(s, nick);
    return a && a.phase === "show" ? a : null;
  });
  // the box is in THIS avatar's hand, and it is the right product
  expect(showing.heldProductId).toBe("TRA_CA_GAI_LEO");
  expect(showing.heldMode).toBe("inHand");
  // stood in front of KE_02 (x≈3, z≈-2.65)
  expect(Math.abs(showing.pos.x - 3)).toBeLessThan(0.9);
  expect(Math.abs(showing.pos.z + 2.65)).toBeLessThan(0.3);
  const s = await state(page);
  expect(s.camera.avatarId).toBe(showing.id);
  await page.waitForTimeout(1500); // let the camera settle
  expect(await cameraShot(page)).toBe("closeup");
  await expect(page.getByTestId("product-card")).toHaveAttribute("data-product-id", "TRA_CA_GAI_LEO");
  await expect(page.getByTestId("product-card")).toContainText("Trà cà gai leo");
  await expect(page.getByTestId("demo-badge")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/T03-2-closeup-holding-box.png` });

  const done = await waitFor(page, (s2) => {
    const a = avatarOf(s2, nick);
    return a && a.completed.length > 0 && a.heldProductId === null ? a : null;
  }, 30_000);
  const sent = (await state(page)).sent.filter((m) => m.command_id === done.completed[0]).map((m) => m.type);
  expect(sent[0]).toBe("ACK");
  expect(sent).toContain("ACTION_STARTED");
  expect(sent[sent.length - 1]).toBe("ACTION_COMPLETED");
  await expect(page.getByTestId("product-card")).toHaveCount(0);

  // backend recorded COMPLETED only after the client confirmed
  const actions = await (await page.request.get("/api/v1/actions")).json();
  expect(actions.find((a: { command_id: string }) => a.command_id === done.completed[0]).status).toBe("COMPLETED");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/T03-3-returned.png` });
});

test("T05: ambiguous 'trà' moves nobody and asks the host", async ({ page }) => {
  const csrf = await login(page.request);
  await openGame(page);
  const nick = `khachle${RUN}`;
  await inject(page, csrf, `@${nick}: trà`);
  await waitFor(page, (s) => avatarOf(s, nick));
  await page.waitForTimeout(3000);
  const a = avatarOf(await state(page), nick)!;
  expect(a.commandId).toBeNull();
  expect(a.heldProductId).toBeNull();
  const sug = await (await page.request.get("/api/v1/ai/suggestions")).json();
  const item = sug.items.find((i: { unique_id: string }) => i.unique_id === nick);
  expect(item.intent).toBe("AMBIGUOUS");
  expect(item.status).toBe("Chưa được trả lời");
});

test("T06 + T07: same user twice and four users on one product", async ({ page }) => {
  const csrf = await login(page.request);
  await openGame(page);
  const users = [0, 1, 2, 3].map((i) => `q${i}${RUN}`);
  for (const u of users) await inject(page, csrf, `@${u}: ba kích`);
  await inject(page, csrf, `@${users[0]}: trà cà gai leo`); // same user, second product
  let maxHolding = 0;
  const seen = new Set<string>();
  await waitFor(page, (s) => {
    for (const u of users) {
      const list = s.avatars.filter((x) => x.nickname === u);
      expect(list.length).toBeLessThanOrEqual(1); // never two avatars for one viewer
      if (list[0]?.heldProductId) seen.add(u);
    }
    const holders = s.avatars.filter((x) => users.includes(x.nickname) && x.phase === "show");
    // no two avatars presenting from the same spot
    const spots = holders.map((h) => `${h.pos.x.toFixed(1)}:${h.pos.z.toFixed(1)}`);
    expect(new Set(spots).size).toBe(spots.length);
    maxHolding = Math.max(maxHolding, holders.length);
    return seen.size === 4 && users.every((u) => (avatarOf(s, u)?.completed.length ?? 0) >= 1);
  }, 90_000);
  expect(maxHolding).toBeLessThanOrEqual(3); // 3 stand positions per shelf (C4)
  await page.screenshot({ path: `${SHOTS}/T07-queue.png` });
  // user 0 eventually runs the second command too (cooldown + preempt, one box at a time)
  await waitFor(page, (s) => (avatarOf(s, users[0])?.completed.length ?? 0) >= 2, 60_000);
});

test("T18: reloading the game mid-action keeps one Chibi per viewer and finishes the action", async ({ page }) => {
  const csrf = await login(page.request);
  await openGame(page);
  const nick = `reload${RUN}`;
  await inject(page, csrf, `@${nick}: trà ba kích`);
  await waitFor(page, (s) => avatarOf(s, nick)?.phase === "to_stand");
  const before = (await state(page)).avatars.length;
  await page.reload();
  await page.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  const after = await waitFor(page, (s) => (s.avatars.length ? s : null));
  expect(after.avatars.filter((a) => a.nickname === nick).length).toBe(1);
  expect(after.avatars.length).toBeLessThanOrEqual(before);
  await waitFor(page, (s) => (avatarOf(s, nick)?.completed.length ?? 0) >= 1, 45_000);
  await page.screenshot({ path: `${SHOTS}/T18-after-reload.png` });
});

test("Dashboard: login, overview, host page shows comments (Vietnamese UI)", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByLabel("Tên đăng nhập").fill("chu_shop");
  await page.getByLabel(/Mật khẩu/).fill("mat-khau-demo-123");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.getByTestId("live-status")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.getByRole("link", { name: "Người trực & Demo" }).click();
  await page.getByRole("button", { name: "@khachle: trà (mơ hồ)" }).click();
  await expect(page.getByTestId("host-item").first()).toContainText("Chưa được trả lời");
  await expect(page.getByTestId("comment-row").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dashboard-host.png`, fullPage: true });
  await page.getByRole("link", { name: "Tổng quan" }).click();
  await expect(page.getByText("Chưa kết nối Shop (mốc M6).")).toBeVisible(); // T19
  await page.screenshot({ path: `${SHOTS}/dashboard-overview.png`, fullPage: true });
  await page.getByRole("link", { name: "Kết nối TikTok" }).click();
  await page.getByLabel("Link TikTok LIVE").fill("https://evil.example/");
  await page.getByRole("button", { name: "Kết nối", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("chỉ chấp nhận tên miền tiktok.com"); // T02
});

test("T17 (load, CPU renderer): 60 avatars + 100 comments — no crash, bounded queue, metrics recorded", async ({ page }) => {
  test.setTimeout(240_000);
  const csrf = await login(page.request);
  await openGame(page, null); // production default: automatic quality step-down
  const texts = ["trà cà gai leo", "trà ba kích", "trà", "chào shop", "nhảy đi"];
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) await inject(page, csrf, `@load${RUN}${i % 60}: ${texts[i % texts.length]}`);
  await page.waitForTimeout(20_000);
  const s = await state(page);
  const m = await (await page.request.get("/api/v1/metrics")).json();
  const fps: number[] = await page.evaluate(() => (window as any).__chibiDebug.fps());
  const mem = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? null);
  const report = {
    renderer: "headless Chrome + SwiftShader (CPU) — not the streaming-PC benchmark",
    injected_comments: 100, seconds: (Date.now() - t0) / 1000,
    client_avatars: s.avatars.length, backend_avatars: m.avatars, queue_depth: m.actions.queue_depth,
    latency: m.actions.latency, fps_last_20: fps.slice(-20), js_heap_bytes: mem, backend_errors: m.errors,
  };
  fs.writeFileSync(`${SHOTS}/T17-load-report.json`, JSON.stringify(report, null, 2));
  await page.screenshot({ path: `${SHOTS}/T17-load.png` });
  expect(m.errors).toBe(0);
  expect(m.avatars.visible).toBeLessThanOrEqual(60);
  expect(m.actions.queue_depth).toBeLessThanOrEqual(60 * 3);
  // at most 60 on stage; evicted Chibis may still be walking to the door
  expect(s.avatars.filter((a) => a.phase !== "exiting").length).toBeLessThanOrEqual(60);
  await page.request.post("/api/v1/live/disconnect", { headers: { "X-CSRF-Token": csrf } }); // clean store for later tests
});

// ---------------------------------------------------------------- M2
test("M2 shelf editor: drag a shelf, refused overlap snaps back, game gets the new layout", async ({ page, context }) => {
  const csrf = await login(page.request);
  const game = await context.newPage();
  await game.goto("/game/live?debug=1&quality=low&role=viewer");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  const v0 = (await state(game)).layoutVersion;

  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/dashboard/shelves");
  const map = page.getByTestId("store-map");
  await expect(map).toBeVisible();
  const shelf = page.getByTestId("shelf-KE_05");
  const box = (await shelf.locator("rect").boundingBox())!;
  const mapBox = (await map.boundingBox())!;
  const pxPerM = mapBox.width / 12.6;
  // drag KE_05 one metre towards the centre (+x) and half a metre back (−z)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + pxPerM * 0.5, box.y + box.height / 2 - pxPerM * 0.25, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2 + pxPerM * 1.0, box.y + box.height / 2 - pxPerM * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => {
    const shelves = await (await page.request.get("/api/v1/shelves")).json();
    return shelves.find((s: { code: string }) => s.code === "KE_05").transform.x;
  }).toBeCloseTo(-2, 1);
  await game.waitForFunction((v) => (window as any).__chibiDebug.state().layoutVersion > v, v0);
  await page.screenshot({ path: `${SHOTS}/M2-shelf-editor.png`, fullPage: true });

  // an overlapping move is refused with a reason and the shelf stays put
  const r = await page.request.patch("/api/v1/shelves/KE_05", { data: { x: 3, z: 3.5 }, headers: { "X-CSRF-Token": csrf } });
  expect(r.status()).toBe(422);
  // keyboard: step right (0.25 m per key) until the server refuses — it must say why
  for (let i = 0; i < 12; i++) {
    await page.getByTestId("shelf-KE_05").focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(400);
    if (await page.getByTestId("layout-error").count()) break;
  }
  await expect(page.getByTestId("layout-error")).toContainText("quá sát");
  const x = (await (await page.request.get("/api/v1/shelves")).json()).find((s: { code: string }) => s.code === "KE_05").transform.x;
  expect(x).toBeLessThanOrEqual(-0.25); // never accepted a position too close to KE_06
  // put it back where the seed had it so later tests see the standard store
  await page.request.patch("/api/v1/shelves/KE_05", { data: { x: -3, z: 3.5 }, headers: { "X-CSRF-Token": csrf } });
});

test("M2 GLB product: the Chibi carries the 3D model, the photo box is the fallback", async ({ page }) => {
  const csrf = await login(page.request);
  const glb = fs.readFileSync("../assets/sample-products/sample_tin.glb");
  const up = await page.request.post("/api/v1/assets/upload", {
    multipart: { kind: "model", file: { name: "tin.glb", mimeType: "model/gltf-binary", buffer: glb } },
    headers: { "X-CSRF-Token": csrf },
  });
  expect(up.status()).toBe(201);
  const modelId = (await up.json()).id;
  const p = await page.request.patch("/api/v1/products/TRA_BA_KICH", { data: { model_asset_id: modelId }, headers: { "X-CSRF-Token": csrf } });
  expect(p.ok()).toBeTruthy();
  const modelUrl = (await p.json()).model_url as string;
  await openGame(page);
  const nick = `glb${RUN}`;
  await inject(page, csrf, `@${nick}: trà ba kích`);
  await waitFor(page, (s) => avatarOf(s, nick)?.phase === "show");
  await page.waitForTimeout(1500);
  const status = await page.evaluate((u) => (globalThis as any).__chibiModels?.[u], modelUrl);
  expect(status).toBe("loaded");
  await page.screenshot({ path: `${SHOTS}/M2-glb-in-hand.png` });
  await page.request.patch("/api/v1/products/TRA_BA_KICH", { data: { model_asset_id: null }, headers: { "X-CSRF-Token": csrf } });
});

test("M2 backup from the dashboard", async ({ page }) => {
  await login(page.request);
  await page.goto("/dashboard/settings");
  const before = await page.getByTestId("backup-row").count();
  await page.getByRole("button", { name: "Sao lưu ngay" }).click();
  await expect(page.getByTestId("backup-row")).toHaveCount(before + 1);
  const href = await page.getByTestId("backup-row").first().locator("a").getAttribute("href");
  const zip = await page.request.get(href!);
  expect((await zip.body()).subarray(0, 2).toString()).toBe("PK");
});

test("M2 crowd: name labels do not overlap", async ({ page }) => {
  const csrf = await login(page.request);
  await page.goto("/game/live?debug=1&quality=medium");
  await page.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  for (let i = 0; i < 14; i++) await inject(page, csrf, `@dong${RUN}${i}: chào`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/M2-crowd-labels.png` });
  // no two visible labels overlap on screen
  const L = await page.evaluate(() => (window as any).__chibiLabels);
  const vis = L.boxes
    .filter((b: any) => L.placement[b.id].visible)
    .map((b: any) => ({ ...b, y: b.y - L.placement[b.id].lift * (b.h + 2) }));
  expect(vis.length).toBeGreaterThan(5);
  for (let i = 0; i < vis.length; i++)
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i], c = vis[j];
      const overlap = Math.abs(a.x - c.x) < (a.w + c.w) / 2 && Math.abs(a.y - c.y) < (a.h + c.h) / 2;
      expect(overlap, `${a.id} vs ${c.id}`).toBe(false);
    }
});
