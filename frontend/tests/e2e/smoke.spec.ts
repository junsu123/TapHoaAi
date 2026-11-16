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
  // the LED screen on the back wall switches to the product the Chibi is holding,
  // and the product card names the viewer
  await page.waitForFunction(() => (window as any).__chibiDebug.state().led.productId === "TRA_CA_GAI_LEO");
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
  await page.waitForFunction(() => (window as any).__chibiDebug.state().led.mode !== "focus");

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
  // with Claude configured the host also gets a draft to review; never read out on its own
  expect(["Chưa được trả lời", "AI đang soạn…", "Cần người trực xem"]).toContain(item.status);
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
  await expect(page.getByTestId("onair")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.getByRole("link", { name: "Người trực & Demo" }).click();
  await page.getByRole("button", { name: "@khachle: trà (mơ hồ)" }).click();
  await expect(page.getByTestId("host-item").first()).toContainText(/Chưa được trả lời|Cần người trực xem/);
  await expect(page.getByTestId("comment-row").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dashboard-host.png`, fullPage: true });
  await page.getByRole("link", { name: "Tổng quan" }).click();
  await expect(page.getByText("Chưa kết nối TikTok Shop.")).toBeVisible(); // T19
  await expect(page.getByTestId("readiness")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dashboard-overview.png`, fullPage: true });
  await page.getByRole("link", { name: "Kết nối TikTok" }).click();
  await page.getByLabel("Link TikTok LIVE").fill("https://evil.example/");
  await expect(page.getByRole("button", { name: "Kết nối", exact: true })).toBeDisabled(); // policy checklist first
  for (const box of await page.locator(".policy input[type=checkbox]").all()) await box.check();
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
  expect(s.avatars.filter((a) => a.phase !== "exiting" && a.phase !== "goodbye").length).toBeLessThanOrEqual(60);
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

// ---------------------------------------------------------------- M3
test("M3 connect page: real TikTok attempt never shows a fake connection; failure is visible", async ({ page }) => {
  // CI has no route to TikTok, so this exercises the honest failure path end to end.
  const csrf = await login(page.request);
  await page.request.post("/api/v1/live/disconnect", { headers: { "X-CSRF-Token": csrf } }); // end any Demo session
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/dashboard/connect");
  await expect(page.getByTestId("live-status")).toContainText("Chưa kết nối");
  await page.getByLabel("Link TikTok LIVE").fill("https://www.tiktok.com/@shoptra/live");
  for (const box of await page.locator(".policy input[type=checkbox]").all()) await box.check();
  await page.getByRole("button", { name: "Kết nối", exact: true }).click();
  const pill = page.getByTestId("live-status");
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    seen.add((await pill.textContent()) ?? "");
    await page.waitForTimeout(250);
  }
  expect([...seen].some((s) => s.includes("Đã kết nối"))).toBe(false);
  // no route to TikTok (sandbox) or TikTok answers "not live / not supported" (CI): never a fake success
  await expect(pill).toContainText(/Mất kết nối|Đang kết nối|Đang kiểm tra|Không hỗ trợ|Không phát LIVE|Đã kết thúc/);
  await page.screenshot({ path: `${SHOTS}/M3-connect-page.png`, fullPage: true });
  await page.request.post("/api/v1/live/disconnect", { headers: { "X-CSRF-Token": csrf } });
  await page.reload();
  await expect(pill).toContainText("Chưa kết nối");
});

test("Product faces from a print PDF: frames on the dieline, 3D preview, saved to the game", async ({ page, context }) => {
  const csrf = await login(page.request);
  await page.setViewportSize({ width: 1360, height: 950 });
  await page.goto("/dashboard/products");
  await page.locator("tr", { hasText: "Cà gai leo" }).first().getByRole("button", { name: "Sửa" }).click();
  await page.getByRole("button", { name: /Lấy tất cả các mặt từ file in PDF/ }).click();
  await page.getByLabel("Rộng (cm)").fill("12");
  await page.getByLabel("Cao (cm)").fill("17");
  await page.getByLabel("Dày (cm)").fill("5.2");
  await page.getByLabel("File in PDF", { exact: true }).setInputFiles("tests/e2e/fixtures/dieline-sample.pdf");
  for (const f of ["front", "back", "left", "right", "top", "bottom"]) await expect(page.getByTestId(`frame-${f}`)).toBeVisible();
  // the first guess lands on the printed panels: the front frame covers the green panel
  await expect
    .poll(async () => {
      const fb = (await page.getByTestId("frame-front").boundingBox())!;
      const lb = (await page.getByTestId("frame-left").boundingBox())!;
      return Math.abs(lb.x + lb.width - fb.x);
    })
    .toBeLessThan(1.5);
  await page.screenshot({ path: `${SHOTS}/PDF-face-picker.png` });
  await page.getByRole("button", { name: "Cắt ảnh các mặt đã chọn" }).click();
  await expect(page.getByTestId("box-preview-3d")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/PDF-face-preview-3d.png` });
  await page.getByRole("button", { name: "Dùng các mặt này" }).click();
  await expect(page.getByTestId("pdf-faces-ready")).toContainText("Đã lấy 6 mặt");
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page.getByTestId("pdf-faces-ready")).toHaveCount(0);

  const p = await (await page.request.get("/api/v1/products/TRA_CA_GAI_LEO", { headers: { "X-CSRF-Token": csrf } })).json();
  expect(p.image_url).toMatch(/\.jpg$/);
  expect(Object.keys(p.face_urls).sort()).toEqual(["back", "bottom", "left", "right", "top"]);
  // the game really loads the new package faces for the shelf box
  const game = await context.newPage();
  const backFace = game.waitForResponse((r) => r.url().endsWith(p.face_urls.back) && r.ok());
  await game.goto("/game/live?debug=1&quality=low&role=viewer");
  await backFace;
  await game.close();
});

test("M4 voice: question read aloud on the OBS page, Claude draft approved by the host, kill switch", async ({ page, context }) => {
  const csrf = await login(page.request);
  const game = await context.newPage();
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&quality=low");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);

  // settings: the voice is off until the policy checklist is ticked
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.goto("/dashboard/ai");
  await expect(page.getByTestId("ai-status")).toContainText("Chế độ thử");
  await expect(page.getByLabel("Bật giọng đọc trên LIVE")).toBeDisabled();
  for (let i = 1; i <= 4; i++) await page.getByLabel(`Chính sách ${i}`).check();
  await page.getByLabel("Bật giọng đọc trên LIVE").check();
  await page.getByLabel("Tên shop").fill("Mộc Tâm");
  await page.getByLabel("Câu đơn giản tự trả lời").uncheck(); // this test follows the Claude path for a price question
  await page.getByRole("button", { name: "Lưu cài đặt" }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  await expect(page.getByTestId("ai-status")).toContainText("Giọng đọc: sẵn sàng");
  await page.getByRole("button", { name: /Nghe thử trên máy này/ }).click();
  await expect(page.getByTestId("voice-test-audio")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/M4-ai-settings.png`, fullPage: true });

  // a viewer asks: the question is read on the OBS page with a caption
  await page.goto("/dashboard/host");
  await page.getByRole("button", { name: "@thuha: hỏi giá" }).click();
  const caption = game.getByTestId("speech-caption");
  await expect(caption).toHaveAttribute("data-kind", "question", { timeout: 15_000 });
  await expect(caption).toContainText("Bạn thuha hỏi: trà cà gai leo giá bao nhiêu vậy shop?");
  const unlock = game.getByTestId("audio-unlock");
  if (await unlock.isVisible()) await unlock.click(); // plain Chrome blocks autoplay; OBS does not
  await game.screenshot({ path: `${SHOTS}/M4-game-question-caption.png` });

  // Claude's draft waits for the host, then is read as "Trợ lý AI"
  const item = page.getByTestId("host-item").filter({ hasText: "thuha" }).first();
  await expect(item).toHaveAttribute("data-status", "AI đề xuất", { timeout: 15_000 });
  await expect(item.getByTestId("suggestion")).toContainText("giá");
  await page.screenshot({ path: `${SHOTS}/M4-host-desk.png`, fullPage: true });
  await item.getByTestId("speak").click();
  await expect(caption).toHaveAttribute("data-kind", "answer", { timeout: 15_000 });
  await expect(caption).toContainText("Trợ lý AI");
  await expect(item).toHaveAttribute("data-status", "Người trực đã xác nhận");
  await game.screenshot({ path: `${SHOTS}/M4-game-answer-caption.png` });

  // kill switch: silence at once, nothing new until turned back on
  await page.getByTestId("voice-kill").click();
  await expect(caption).toHaveCount(0);
  await expect(page.getByTestId("voice-unmute")).toBeVisible();
  await page.getByRole("button", { name: "@namvo: hỏi ship" }).click();
  await page.waitForTimeout(1500);
  await expect(caption).toHaveCount(0);
  await page.getByTestId("voice-unmute").click();

  // leave the voice off for the other tests
  const s = await (await page.request.get("/api/v1/settings/ai")).json();
  await page.request.put("/api/v1/settings/ai", { data: { config: { ...s.config, voice_enabled: false } }, headers: { "X-CSRF-Token": csrf } });
  await game.close();
});

test("Learning: an answer the host confirmed is reused for a similar question without Claude", async ({ page, context }) => {
  const csrf = await login(page.request);
  const s = await (await page.request.get("/api/v1/settings/ai")).json();
  const cfg = { ...s.config, voice_enabled: true, voice_policy_confirmed: true, simple_auto: true, simple_auto_speak: true, learn_enabled: true };
  await page.request.put("/api/v1/settings/ai", { data: { config: cfg }, headers: { "X-CSRF-Token": csrf } });
  await page.request.post("/api/v1/voice/unmute", { headers: { "X-CSRF-Token": csrf } });
  const game = await context.newPage();
  await game.goto("/game/live?debug=1&quality=low");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  const nick1 = `hoiship${RUN}`;
  const nick2 = `hoilai${RUN}`;

  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.goto("/dashboard/host");
  await inject(page, csrf, `@${nick1}: shop ơi có ship COD toàn quốc không`);
  const first = page.getByTestId("host-item").filter({ hasText: nick1 }).first();
  await expect(first).toHaveAttribute("data-status", /Cần người trực xem|AI đề xuất/, { timeout: 15_000 });
  await first.getByRole("button", { name: /Sửa rồi đọc|Viết câu trả lời/ }).click();
  await first.getByLabel("Sửa câu trả lời").fill("Dạ shop có giao COD toàn quốc, bạn nhận hàng rồi thanh toán ạ.");
  await first.getByRole("button", { name: "Đọc câu đã sửa" }).click();
  await expect(first).toHaveAttribute("data-status", "Người trực đã xác nhận");

  // a different viewer, different words, same question → answered at once, no Claude
  await inject(page, csrf, `@${nick2}: sốp có giao cod toàn quốc ko ạ`);
  const second = page.getByTestId("host-item").filter({ hasText: nick2 }).first();
  await expect(second).toHaveAttribute("data-status", "Đã trả lời tự động", { timeout: 15_000 });
  await expect(second.getByTestId("suggestion")).toContainText("Câu đã học");
  await expect(game.getByTestId("speech-caption")).toContainText("nhận hàng rồi thanh toán", { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/LEARN-host-auto-answer.png`, fullPage: true });

  await page.goto("/dashboard/knowledge");
  await expect(page.getByTestId("kn-stats")).toContainText(/[1-9]\d* câu tự trả lời/);
  await expect(page.getByTestId("kn-entry").filter({ hasText: "giao COD toàn quốc" })).toBeVisible();
  await page.getByLabel("Câu hỏi thử").fill("có nhận hàng rồi trả tiền ko shop");
  await page.getByRole("button", { name: "Thử", exact: true }).click();
  await expect(page.getByTestId("kn-test")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/LEARN-knowledge.png`, fullPage: true });
  await page.getByRole("button", { name: "Lịch sử hội thoại LIVE" }).click();
  await expect(page.getByTestId("conv-table")).toContainText(nick2);
  await expect(page.getByTestId("conv-table")).toContainText("Câu đã học");
  await page.screenshot({ path: `${SHOTS}/LEARN-history.png`, fullPage: true });
  const csv = await page.request.get("/api/v1/conversations/export.csv");
  expect(await csv.text()).toContain(nick1);

  await page.request.put("/api/v1/settings/ai", { data: { config: { ...cfg, voice_enabled: false } }, headers: { "X-CSRF-Token": csrf } });
  await game.close();
});

test("Autopilot: one switch reads comments and answers them without the host", async ({ page, context }) => {
  const csrf = await login(page.request);
  const s = await (await page.request.get("/api/v1/settings/ai")).json();
  const cfg = { ...s.config, voice_policy_confirmed: true, voice_enabled: true, autopilot: false, simple_auto: true };
  await page.request.put("/api/v1/settings/ai", { data: { config: cfg }, headers: { "X-CSRF-Token": csrf } });
  await page.request.post("/api/v1/voice/unmute", { headers: { "X-CSRF-Token": csrf } });
  const game = await context.newPage();
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&quality=low");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  const caption = game.getByTestId("speech-caption");

  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.goto("/dashboard/host");
  const toggle = page.getByTestId("autopilot-toggle");
  await expect(toggle).toContainText("đang tắt");
  await toggle.click();
  await expect(toggle).toContainText("đang bật");

  await inject(page, csrf, `@chao${RUN}: chào shop nha`);
  await expect(caption).toContainText(`chao${RUN}`, { timeout: 20_000 });
  await expect(caption).toContainText("Trợ lý AI");
  await game.screenshot({ path: `${SHOTS}/AUTO-greeting.png` });

  await inject(page, csrf, `@xem${RUN}: trà ba kích`);
  await expect(caption).toContainText("đang xem", { timeout: 20_000 });

  await inject(page, csrf, `@hoi${RUN}: trà ba kích giá bao nhiêu vậy`);
  const item = page.getByTestId("host-item").filter({ hasText: `hoi${RUN}` }).first();
  await expect(item).toHaveAttribute("data-status", "Đã trả lời tự động", { timeout: 20_000 });
  await expect(caption).toHaveAttribute("data-kind", "answer", { timeout: 25_000 });
  await page.screenshot({ path: `${SHOTS}/AUTO-host.png`, fullPage: true });
  // every comment once (regression: demo event ids repeated across sessions)
  const rows = (await page.getByTestId("comment-row").allInnerTexts()).filter((t) => t.includes(RUN));
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(rows).size).toBe(rows.length);

  await toggle.click();
  await expect(toggle).toContainText("đang tắt");
  await page.request.put("/api/v1/settings/ai", { data: { config: { ...cfg, voice_enabled: false } }, headers: { "X-CSRF-Token": csrf } });
  await game.close();
});

test("Vbee voice: pick a voice from the account's list (any code shape) and save it", async ({ page }) => {
  const csrf = await login(page.request);
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.goto("/dashboard/ai");
  await page.getByTestId("load-voices").click();
  const select = page.getByTestId("voice-select");
  await expect(select).toBeVisible();
  await expect(select.locator("optgroup")).toHaveCount(2);
  await select.selectOption("personal:shop-moctam/giong-chu-shop");
  await expect(page.getByLabel("Mã giọng", { exact: true })).toHaveValue("personal:shop-moctam/giong-chu-shop");
  await page.getByRole("button", { name: "Lưu cài đặt" }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  await page.getByTestId("voice-select").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/VOICE-picker.png`, fullPage: true });
  const s = await (await page.request.get("/api/v1/settings/ai")).json();
  expect(s.config.voice_code).toBe("personal:shop-moctam/giong-chu-shop");
  await page.getByRole("button", { name: /Nghe thử trên máy này/ }).click();
  await expect(page.getByTestId("voice-test-audio")).toBeVisible();

  await page.getByTestId("voice-diagnose").click();
  await expect(page.getByTestId("voice-diag")).toContainText("Chế độ thử");

  // a code with a space gets a clear Vietnamese message instead of a regex
  await page.getByLabel("Mã giọng", { exact: true }).fill("giong co khoang trang");
  await page.getByRole("button", { name: "Lưu cài đặt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("khoảng trắng");
  await page.request.put("/api/v1/settings/ai", { data: { config: { ...s.config, voice_code: "hn_female_ngochuyen_full_48k-fhg" } }, headers: { "X-CSRF-Token": csrf } });
});

test("Error log: a JavaScript error on the OBS page shows up live in Nhật ký lỗi", async ({ page, context }) => {
  await login(page.request);
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto("/dashboard/logs");
  await page.waitForTimeout(500);
  await page.goto("/dashboard");
  await expect(page.getByTestId("log-badge")).toHaveCount(0);

  const game = await context.newPage();
  await game.goto("/game/live?debug=1&quality=low&role=viewer");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  await game.evaluate((run) => setTimeout(() => { throw new Error(`lỗi thử từ trang game ${run}`); }), RUN);
  await expect(page.getByTestId("log-badge")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("link", { name: /Nhật ký lỗi/ }).click();
  const row = page.getByTestId("log-row").filter({ hasText: `lỗi thử từ trang game ${RUN}` });
  await expect(row).toContainText("Trang game (OBS)");
  await row.locator(".log-head").click();
  await expect(row.locator(".log-trace")).toBeVisible();
  await expect(page.getByTestId("log-badge")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/LOG-page.png`, fullPage: true });
  const txt = await (await page.request.get("/api/v1/logs/export.txt")).text();
  expect(txt).toContain(`lỗi thử từ trang game ${RUN}`);
  await game.close();
});

test("Welcome: ten viewers join at once and every name is greeted; ordinary comments are read", async ({ page, context }) => {
  const csrf = await login(page.request);
  const s = await (await page.request.get("/api/v1/settings/ai")).json();
  const cfg = { ...s.config, voice_policy_confirmed: true, voice_enabled: true, greet_joins: true, read_comments: true, autopilot: false, owner_chat: false };
  await page.request.put("/api/v1/settings/ai", { data: { config: cfg }, headers: { "X-CSRF-Token": csrf } });
  await page.request.post("/api/v1/voice/unmute", { headers: { "X-CSRF-Token": csrf } });
  const game = await context.newPage();
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&quality=low");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  const caption = game.getByTestId("speech-caption");

  await page.goto("/dashboard/host");
  const before = new Set(((await game.evaluate(() => (window as any).__chibiDebug.state().avatars)) as { nickname: string }[]).map((a) => a.nickname));
  await page.getByRole("button", { name: "+10 người xem giả" }).click();
  await game.waitForFunction((n) => (window as any).__chibiDebug.state().avatars.length >= n, before.size + 10);
  const joined = ((await game.evaluate(() => (window as any).__chibiDebug.state().avatars)) as { nickname: string }[])
    .map((a) => a.nickname)
    .filter((n) => !before.has(n));
  expect(joined.length).toBe(10);

  // collect every welcome caption until all ten names have been on screen
  let seen = "";
  let shot = false;
  for (let i = 0; i < 150 && !joined.every((n) => seen.includes(n)); i++) {
    if (await caption.isVisible()) {
      const t = await caption.innerText();
      if (!seen.includes(t)) seen += "\n" + t;
      if (!shot && (await caption.getAttribute("data-kind")) === "welcome") {
        await game.screenshot({ path: `${SHOTS}/WELCOME-caption.png` });
        shot = true;
      }
    }
    await game.waitForTimeout(200);
  }
  for (const n of joined) expect(seen).toContain(n);

  await page.getByRole("button", { name: "@vy: bình luận thường" }).click();
  await expect(caption).toContainText("Bạn vy nói: hôm nay shop đẹp quá", { timeout: 20_000 });
  await expect(caption).toHaveAttribute("data-kind", "comment");
  await page.screenshot({ path: `${SHOTS}/WELCOME-host.png`, fullPage: true });

  await page.request.put("/api/v1/settings/ai", { data: { config: { ...cfg, voice_enabled: false } }, headers: { "X-CSRF-Token": csrf } });
  await game.close();
});

test("Herbal-tea shop look and product banner: rotates, follows the Chibi, settings switch it off/theme", async ({ page, context }) => {
  test.setTimeout(180_000);
  const csrf = await login(page.request);
  const put = async (patch: object) => {
    const cur = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
    const r = await page.request.put("/api/v1/settings/scene", { data: { ...cur, ...patch }, headers: { "X-CSRF-Token": csrf } });
    expect(r.ok()).toBeTruthy();
  };
  await put({ theme: "herbal", banner_enabled: true, banner_style: "tv", banner_mode: "scroll", banner_seconds: 4, banner_product_ids: [], wall_posters: true });
  const game = await context.newPage();
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&quality=medium");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().scene?.theme === "herbal");
  const banner = game.getByTestId("product-banner");
  await expect(banner).toHaveAttribute("data-mode", "scroll", { timeout: 40_000 }); // after any showcase left over from earlier tests
  // continuous: the strip keeps moving, every product is on it
  const track = game.getByTestId("banner-track");
  await expect(track.locator(".scroll-card[data-product-id=TRA_CA_GAI_LEO]").first()).toBeAttached();
  await expect(track.locator(".scroll-card[data-product-id=TRA_BA_KICH]").first()).toBeAttached();
  const x = () => track.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  const x1 = await x();
  await game.waitForTimeout(700);
  const x2 = await x();
  await game.waitForTimeout(700);
  const x3 = await x();
  expect(x2).toBeLessThan(x1);
  expect(x3).toBeLessThan(x2);
  await game.screenshot({ path: `${SHOTS}/SCENE-herbal-banner.png` });

  // one-at-a-time mode still available
  await put({ banner_mode: "slide", banner_seconds: 3 });
  await expect(banner).toHaveAttribute("data-mode", "slide");
  await expect(banner.locator("img")).toBeVisible();
  const first = await banner.getAttribute("data-product-id");
  await expect(banner).not.toHaveAttribute("data-product-id", first!, { timeout: 8_000 }); // rotates
  await game.screenshot({ path: `${SHOTS}/SCENE-herbal-banner-slide.png` });
  await put({ banner_mode: "scroll", banner_seconds: 6 });

  // banner off → the sign board and the wall posters are visible again
  await put({ banner_enabled: false });
  await expect(banner).toHaveCount(0);
  await game.waitForFunction(() => (window as any).__chibiDebug.state().scene.banner === false);
  await game.waitForTimeout(2500);
  await game.screenshot({ path: `${SHOTS}/SCENE-herbal-no-banner.png` });

  // the old pink theme is still there
  await put({ theme: "kawaii", banner_enabled: true });
  await game.waitForFunction(() => (window as any).__chibiDebug.state().scene.theme === "kawaii");
  await game.waitForTimeout(1500);
  await game.screenshot({ path: `${SHOTS}/SCENE-kawaii-banner.png` });
  // default: an LED screen fixed on the back wall (in the 3D shop), nothing over the frame
  await put({ theme: "herbal", banner_enabled: true, banner_style: "led", banner_mode: "scroll", banner_seconds: 6 });
  await expect(banner).toHaveCount(0);
  await game.waitForFunction(() => (window as any).__chibiDebug.state().led.mode === "scroll", null, { timeout: 40_000 });
  await game.waitForTimeout(2500);
  await game.screenshot({ path: `${SHOTS}/SCENE-led-wall.png` });

  // dashboard settings card
  await page.setViewportSize({ width: 1360, height: 1100 });
  await page.goto("/dashboard/game");
  await expect(page.getByRole("heading", { name: /Không gian cửa hàng/ })).toBeVisible();
  await page.getByLabel("Chữ trên biển hiệu").fill("TRÀ MỘC TÂM");
  await page.locator(".banner-pick-item").first().click();
  await page.getByRole("button", { name: "Lưu không gian & banner" }).click();
  await expect(page.getByText("Đã lưu — màn hình LIVE đổi ngay.")).toBeVisible();
  expect((await (await page.request.get("/api/v1/settings/scene")).json()).config.sign_text).toBe("TRÀ MỘC TÂM");
  await page.screenshot({ path: `${SHOTS}/SCENE-settings.png`, fullPage: true });
  await put({ sign_text: "TIỆM TRÀ THẢO MỘC", banner_product_ids: [] });
  await game.close();
});

test("Voice checklist: says why nobody is greeted, then shows greetings and comments going on the LIVE", async ({ page, context }) => {
  test.setTimeout(150_000);
  const csrf = await login(page.request);
  const s = await (await page.request.get("/api/v1/settings/ai")).json();
  const off = { ...s.config, voice_enabled: false, greet_joins: true, read_comments: true, autopilot: false };
  await page.request.put("/api/v1/settings/ai", { data: { config: off }, headers: { "X-CSRF-Token": csrf } });
  await page.request.post("/api/v1/voice/unmute", { headers: { "X-CSRF-Token": csrf } });
  await page.setViewportSize({ width: 1360, height: 1200 });
  await page.goto("/dashboard/host");
  const vc = page.getByTestId("voice-check");
  await expect(vc.getByTestId("check-voice")).toHaveAttribute("data-ok", "0");
  await expect(vc.getByTestId("check-voice")).toContainText("Bật phát trên LIVE");
  const nick = `vaoxem${RUN}`;
  await page.request.post("/api/v1/demo/events", { data: { type: "JOIN", unique_id: nick, nickname: nick }, headers: { "X-CSRF-Token": csrf } });
  await expect(vc.getByTestId("voice-trace")).toContainText(nick);
  await expect(vc.getByTestId("voice-trace")).toContainText("Phát trên LIVE đang tắt");
  await vc.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/VOICECHECK-off.png`, fullPage: true });

  // turn it on and open the OBS page: everything green, joins and comments go on the LIVE
  await page.request.put("/api/v1/settings/ai", { data: { config: { ...off, voice_enabled: true, voice_policy_confirmed: true } }, headers: { "X-CSRF-Token": csrf } });
  const game = await context.newPage();
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&quality=low");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  await expect(vc.getByTestId("check-voice")).toHaveAttribute("data-ok", "1", { timeout: 10_000 });
  await expect(vc.getByTestId("check-player")).toHaveAttribute("data-ok", "1", { timeout: 10_000 });
  const nick2 = `vaolai${RUN}`;
  await page.request.post("/api/v1/demo/events", { data: { type: "JOIN", unique_id: nick2, nickname: nick2 }, headers: { "X-CSRF-Token": csrf } });
  await expect(vc.getByTestId("voice-trace")).toContainText("Đã xếp lời chào lên LIVE", { timeout: 10_000 });
  await inject(page, csrf, `@${nick2}: live hôm nay vui ghê`);
  await expect(vc.getByTestId("voice-trace")).toContainText("Đã xếp hàng đọc trên LIVE", { timeout: 10_000 });
  await vc.getByTestId("voice-test-live").click();
  await expect(vc.getByTestId("voice-test-live-msg")).toContainText("Đã gửi câu thử", { timeout: 20_000 });
  await expect(game.locator("[data-testid=speech-caption][data-kind=test]")).toBeVisible({ timeout: 20_000 });
  await vc.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/VOICECHECK-on.png`, fullPage: true });

  await page.goto("/dashboard/ai");
  await expect(page.getByLabel("Giọng có sẵn của máy")).toBeChecked();
  await page.request.put("/api/v1/settings/ai", { data: { config: { ...off } }, headers: { "X-CSRF-Token": csrf } });
  await game.close();
});

test("Tea house: TV banner, owner greets joins with a bubble, gift giver is served tea, honour board", async ({ page, context }) => {
  test.setTimeout(180_000);
  const csrf = await login(page.request);
  const H = { "X-CSRF-Token": csrf };
  const cur = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
  await page.request.put("/api/v1/settings/scene", { data: { ...cur, theme: "herbal", banner_enabled: true, banner_style: "led", owner_enabled: true, board_enabled: true, board_position: "left" }, headers: H });
  await page.request.post("/api/v1/leaderboard/reset", { headers: H });
  const game = await context.newPage();
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&quality=medium");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().tea?.spot);
  await game.waitForFunction(() => ["scroll", "slide", "focus"].includes((window as any).__chibiDebug.state().led.mode), null, { timeout: 40_000 });
  await expect(game.getByTestId("product-banner")).toHaveCount(0);
  await expect(game.getByTestId("honour-board")).toBeVisible();

  // joins → the owner stands, bows and greets them by name in one bubble
  const tag = RUN.slice(-3);
  for (const n of ["Thu", "Bảo", "Ngân"]) {
    await page.request.post("/api/v1/demo/events", { data: { type: "JOIN", unique_id: `${n}${tag}`.normalize("NFD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase(), nickname: `${n} ${tag}` }, headers: H });
  }
  const bubble = game.getByTestId("owner-bubble");
  await expect(bubble).toContainText(`Xin chào quý khách Thu ${tag}, Bảo ${tag} và Ngân ${tag} đã vào quán!`, { timeout: 15_000 });
  await game.waitForFunction(() => ["rise", "bow", "stand"].includes((window as any).__chibiDebug.state().tea.pose), null, { timeout: 5_000 });
  await game.waitForTimeout(900);
  await game.screenshot({ path: `${SHOTS}/TEA-1-greeting.png` });

  // the host records a purchase → the owner thanks the buyer; the buyer is on the board
  await page.setViewportSize({ width: 1360, height: 1200 });
  await page.goto("/dashboard/host");
  const card = page.getByTestId("board-card");
  await card.getByLabel("Tên khách").fill("Minh Tú");
  await card.getByLabel("Sản phẩm đã mua").selectOption("TRA_CA_GAI_LEO");
  await card.getByLabel("Số lượng").fill("2");
  await card.getByRole("button", { name: "Ghi đơn" }).click();
  await expect(card.getByTestId("purchase-msg")).toContainText("Minh Tú");
  await expect(bubble).toContainText("Cảm ơn Minh Tú đã mua 2 Trà cà gai leo ạ!", { timeout: 15_000 });
  await expect(game.getByTestId("honour-board")).toContainText("Minh Tú", { timeout: 20_000 });

  // a gift → the giver's Chibi walks to the tea table, sits opposite the owner and is served
  await page.getByRole("button", { name: "Quà (kết thúc chuỗi ×5)" }).click();
  await game.waitForFunction(() => (window as any).__chibiDebug.state().tea.guest?.seated === true, null, { timeout: 40_000 });
  await expect(bubble).toContainText("Mời Lan Anh dùng trà ạ! Cảm ơn Lan Anh đã tặng 5 Hoa hồng!");
  await game.waitForFunction(() => (window as any).__chibiDebug.state().tea.cupFull === true, null, { timeout: 10_000 });
  await game.waitForTimeout(1200);
  // the camera frames the table (unless another viewer's product close-up has priority)
  const cam = (await game.evaluate(() => (window as any).__chibiCamera)).shot;
  expect(["tea", "closeup"]).toContain(cam);
  expect(await game.evaluate(() => (window as any).__chibiDebug.state().tea.teaShot)).toBe(true);
  await game.screenshot({ path: `${SHOTS}/TEA-2-serving.png` });
  await expect(card).toContainText("Lan Anh");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/TEA-3-host-board.png`, fullPage: true });
  // back to the overview with the board showing both lists
  await game.waitForFunction(() => !(window as any).__chibiDebug.state().tea.teaShot, null, { timeout: 20_000 });
  await game.waitForTimeout(2500);
  await game.screenshot({ path: `${SHOTS}/TEA-4-overview-board.png` });
  await page.request.post("/api/v1/leaderboard/reset", { headers: H });
  await game.close();
});

test("Honour board: drag it anywhere on the LIVE screen and resize it from the dashboard", async ({ page, context }) => {
  test.setTimeout(150_000);
  const csrf = await login(page.request);
  const cur = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
  await page.request.put("/api/v1/settings/scene", { data: { ...cur, board_enabled: true, board_x: null, board_y: null, board_scale: 1, stage_enabled: true, stage_board_x: null, stage_board_y: null, stage_board_scale: 1 }, headers: { "X-CSRF-Token": csrf } });
  const game = await context.newPage();
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&quality=low");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);

  await page.setViewportSize({ width: 1360, height: 1300 });
  await page.goto("/dashboard/game");
  await page.getByRole("button", { name: "Kéo thả bảng vàng và ô Sân khấu tới chỗ muốn đặt" }).click();
  const frame = page.frameLocator('[data-testid="board-placer-frame"]');
  const board = frame.getByTestId("honour-board");
  await expect(board).toBeVisible({ timeout: 20_000 });
  const iframeBox = (await page.getByTestId("board-placer-frame").boundingBox())!;
  const b = (await board.boundingBox())!;
  // drag the board up and to the right
  await page.mouse.move(b.x + 30, b.y + 15);
  await page.mouse.down();
  await page.mouse.move(b.x + 80, b.y - 120, { steps: 8 });
  await page.mouse.move(b.x + 110, b.y - 200, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("board-place-note")).toContainText("Đã lưu vị trí bảng vàng", { timeout: 10_000 });
  const saved = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
  const expX = (b.x + 80 - iframeBox.x - 1) / iframeBox.width; // pointer moved 80 px right
  expect(saved.board_x).toBeGreaterThan(expX - 0.08);
  expect(saved.board_x).toBeLessThan(expX + 0.08);
  expect(saved.board_y).toBeLessThan((b.y - iframeBox.y) / iframeBox.height - 0.2); // 215 px up

  // resize from the corner handle
  const h = (await frame.getByTestId("board-resize").boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 60, h.y + 20, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId("board-place-note")).toContainText(/cỡ 1[1-8]\d%/, { timeout: 10_000 });
  const sized = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
  expect(sized.board_scale).toBeGreaterThan(1.1);
  await page.screenshot({ path: `${SHOTS}/BOARD-drag-dashboard.png`, fullPage: true });

  // the OBS page moved the board right away
  const gb = game.getByTestId("honour-board");
  await expect.poll(async () => (await gb.evaluate((el) => (el as HTMLElement).style.left))).toBe(`${sized.board_x * 100}%`);
  await game.waitForTimeout(800);
  await game.screenshot({ path: `${SHOTS}/BOARD-moved-live.png` });

  // the "Sân khấu" box moves the same way: drag it from the top right down to the left
  const sb = frame.getByTestId("stage-board");
  await expect(sb).toBeVisible();
  const s0 = (await sb.boundingBox())!;
  await page.mouse.move(s0.x + 20, s0.y + 12);
  await page.mouse.down();
  await page.mouse.move(s0.x - 60, s0.y + 60, { steps: 8 });
  await page.mouse.move(s0.x - 140, s0.y + 120, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("board-place-note")).toContainText("Đã lưu vị trí ô Sân khấu", { timeout: 10_000 });
  let sc = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
  expect(sc.stage_board_x).toBeLessThan((s0.x - iframeBox.x) / iframeBox.width - 0.2); // 140 px left
  expect(sc.stage_board_y).toBeGreaterThan((s0.y - iframeBox.y) / iframeBox.height + 0.1); // 120 px down
  expect(sc.board_x).toBe(sized.board_x); // the honour board stays where it was
  const sh = (await frame.getByTestId("stage-board-resize").boundingBox())!;
  await page.mouse.move(sh.x + sh.width / 2, sh.y + sh.height / 2);
  await page.mouse.down();
  await page.mouse.move(sh.x + 50, sh.y + 15, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId("board-place-note")).toContainText(/ô Sân khấu \(cỡ 1[1-8]\d%\)/, { timeout: 10_000 });
  sc = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
  expect(sc.stage_board_scale).toBeGreaterThan(1.1);
  const gs = game.getByTestId("stage-board");
  await expect(gs).toHaveAttribute("data-placed", "1", { timeout: 10_000 });
  await expect.poll(async () => (await gs.evaluate((el) => (el as HTMLElement).style.left))).toBe(`${sc.stage_board_x * 100}%`);
  await page.screenshot({ path: `${SHOTS}/STAGE-BOARD-drag-dashboard.png`, fullPage: true });
  await game.waitForTimeout(800);
  await game.screenshot({ path: `${SHOTS}/STAGE-BOARD-moved-live.png` });

  // back to their default spots
  await page.getByRole("button", { name: "Bảng vàng về góc mặc định" }).click();
  await expect(page.getByTestId("board-place-note")).toContainText("góc mặc định");
  await expect.poll(async () => (await gb.evaluate((el) => (el as HTMLElement).style.left))).toBe("");
  await page.getByRole("button", { name: "Ô Sân khấu về chỗ mặc định" }).click();
  await expect(page.getByTestId("board-place-note")).toContainText("ô Sân khấu về chỗ mặc định");
  await expect(gs).not.toHaveAttribute("data-placed", "1", { timeout: 10_000 });
  await game.close();
});

test("Behaviour V3: Chibis live on their own, take product commands, queue dance, leave on 'về thôi' (with demo frames)", async ({ page, context }) => {
  test.setTimeout(240_000);
  const csrf = await login(page.request);
  const H = { "X-CSRF-Token": csrf };
  const cur = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
  // "nhảy" = dance in place here (with the stage on it queues for the stage — see the stage test)
  await page.request.put("/api/v1/settings/scene", { data: { ...cur, owner_enabled: true, board_enabled: false, stage_enabled: false }, headers: H });
  const game = await context.newPage();
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&overlay=1&quality=medium");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  const tag = RUN.slice(-3);
  await page.request.post("/api/v1/demo/events", { data: { type: "SPAWN_RANDOM", count: 12, seed: 77 }, headers: H });
  const st = () => game.evaluate(() => (window as any).__chibiDebug.state());
  const frames: string[] = [];
  const frame = async (name: string) => {
    const p = `${SHOTS}/BEHAVIOR-frame-${String(frames.length).padStart(3, "0")}-${name}.png`;
    await game.screenshot({ path: p });
    frames.push(p);
  };

  // autonomous life: within ~40 s several different activities and top states appear
  const behaviours = new Set<string>();
  const tops = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const s = await st();
    for (const a of s.avatars) {
      behaviours.add(a.behavior);
      tops.add(a.top);
    }
    if (i % 4 === 0) await frame("life");
    await game.waitForTimeout(1000);
  }
  expect(behaviours.size).toBeGreaterThanOrEqual(5);
  expect([...tops]).toEqual(expect.arrayContaining(["IDLE", "NAVIGATING", "BROWSING"]));
  await expect(game.getByTestId("behavior-debug")).toBeVisible();

  // a product comment: this viewer's own Chibi walks to KE_02, picks, presents, returns
  const nick = `beh${tag}`;
  await inject(page, csrf, `@${nick}: trà cà gai leo`);
  await game.waitForFunction((n) => (window as any).__chibiDebug.state().avatars.some((a: any) => a.nickname === n && a.top === "PRESENTING"), nick, { timeout: 40_000 });
  await frame("presenting");
  // a dance request while busy waits in the queue …
  await inject(page, csrf, `@${nick}: nhảy đi`);
  await game.waitForFunction((n) => (window as any).__chibiDebug.state().avatars.some((a: any) => a.nickname === n && a.directQueue.includes("dance")), nick, { timeout: 10_000 });
  // … and is danced after the box is back on the shelf
  await game.waitForFunction((n) => (window as any).__chibiDebug.state().avatars.some((a: any) => a.nickname === n && a.behavior === "FUN_DANCE"), nick, { timeout: 40_000 });
  await frame("dance-after-product");
  const me = (await st()).avatars.find((a: any) => a.nickname === nick);
  expect(me.heldProductId).toBeNull();
  expect(me.history).toEqual(expect.arrayContaining(["PRODUCT_ROUTE", "FUN_DANCE"]));

  // "về thôi": waves and walks out; nothing left behind
  await inject(page, csrf, `@${nick}: về thôi`);
  await game.waitForFunction((n) => (window as any).__chibiDebug.state().avatars.some((a: any) => a.nickname === n && a.top === "LEAVING"), nick, { timeout: 10_000 });
  await frame("leaving");
  await game.waitForFunction((n) => !(window as any).__chibiDebug.state().avatars.some((a: any) => a.nickname === n), nick, { timeout: 40_000 });
  await frame("left");
  await game.close();
});

test("Behaviour P1: missing dance clip falls back (T12), Chibis keep living calmly while the voice talks (T15), settings from the dashboard", async ({ page, context }) => {
  test.setTimeout(200_000);
  const csrf = await login(page.request);
  const H = { "X-CSRF-Token": csrf };
  const scene = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
  // "nhảy" = dance in place; no level-up lines on the voice (this test counts voices)
  await page.request.put("/api/v1/settings/scene", { data: { ...scene, stage_enabled: false, level_voice: false }, headers: H });
  const game = await context.newPage();
  // a fake computer voice that talks for 6 s; counts how many voices / audio clips play at once
  await game.addInitScript(() => {
    const w = window as any;
    w.__sound = { speaking: 0, maxAtOnce: 0, speaks: 0, mediaPlays: 0 };
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      w.__sound.mediaPlays++;
      w.__sound.speaking++;
      w.__sound.maxAtOnce = Math.max(w.__sound.maxAtOnce, w.__sound.speaking);
      const done = () => {
        w.__sound.speaking--;
        this.removeEventListener("ended", done);
        this.removeEventListener("pause", done);
      };
      this.addEventListener("ended", done);
      this.addEventListener("pause", done);
      return orig.call(this);
    };
    class U {
      text: string; voice: any = null; lang = ""; rate = 1;
      onstart: any = null; onend: any = null; onerror: any = null;
      constructor(t: string) { this.text = t; }
    }
    const voice = { name: "Fake Vietnamese", lang: "vi-VN", localService: true };
    w.SpeechSynthesisUtterance = U;
    Object.defineProperty(w, "speechSynthesis", {
      value: {
        getVoices: () => [voice],
        cancel: () => undefined, pause: () => undefined, resume: () => undefined,
        addEventListener: () => undefined, removeEventListener: () => undefined,
        speak: (u: any) => {
          w.__sound.speaks++;
          w.__sound.speaking++;
          w.__sound.maxAtOnce = Math.max(w.__sound.maxAtOnce, w.__sound.speaking);
          setTimeout(() => u.onstart?.(), 30);
          setTimeout(() => { w.__sound.speaking--; u.onend?.(); }, 6000);
        },
      },
      configurable: true,
    });
  });
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&overlay=1&quality=medium&noclip=dance");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  const st = () => game.evaluate(() => (window as any).__chibiDebug.state());
  const tag = RUN.slice(-3);

  // T12: "nhảy" without a dance clip → the Chibi still does FUN_DANCE, drawn with the cheer clip
  const nick = `clip${tag}`;
  await inject(page, csrf, `@${nick}: chào shop`);
  await game.waitForFunction((n) => (window as any).__chibiDebug.state().avatars.some((a: any) => a.nickname === n && a.top !== "ENTERING"), nick, { timeout: 30_000 });
  await inject(page, csrf, `@${nick}: nhảy đi`);
  await game.waitForFunction((n) => (window as any).__chibiDebug.state().avatars.some((a: any) => a.nickname === n && a.behavior === "FUN_DANCE" && a.pose === "cheer"), nick, { timeout: 20_000 });
  expect((await st()).clipWarnings).toContain("dance → cheer");
  await game.screenshot({ path: `${SHOTS}/P1-T12-dance-fallback-cheer.png` });

  // T15: the voice talks → the shop stays alive (Chibis move), no dance/pose/spin starts, one voice at a time
  await page.request.post("/api/v1/demo/events", { data: { type: "SPAWN_RANDOM", count: 10, seed: 15 }, headers: H });
  await game.waitForTimeout(6000);
  const ai = await (await page.request.get("/api/v1/settings/ai")).json();
  await page.request.put("/api/v1/settings/ai", { data: { config: { ...ai.config, voice_enabled: true, voice_policy_confirmed: true, owner_chat: false, poem_story: false } }, headers: H });
  await page.request.post("/api/v1/voice/unmute", { headers: H });
  const r = await page.request.post("/api/v1/voice/test-live", { headers: H });
  expect(r.ok()).toBeTruthy();
  await game.waitForFunction(() => (window as any).__chibiDebug.state().hostSpeaking === true, null, { timeout: 15_000 });
  const before = await st();
  await game.waitForTimeout(1500);
  const during = await st();
  await game.screenshot({ path: `${SHOTS}/P1-T15-voice-talking.png` });
  expect(during.hostSpeaking).toBe(true);
  const moved = during.avatars.filter((a: any) => {
    const b = before.avatars.find((x: any) => x.id === a.id);
    return b && Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) > 0.2;
  });
  expect(moved.length).toBeGreaterThanOrEqual(2); // still alive, not frozen
  for (const a of during.avatars) {
    const b = before.avatars.find((x: any) => x.id === a.id);
    const fresh = b ? a.history.slice(b.history.length) : [];
    expect(fresh.filter((h: string) => /^FUN_(DANCE|POSE|SPIN)$/.test(h)), a.nickname).toEqual([]);
  }
  await game.waitForFunction(() => (window as any).__chibiDebug.state().hostSpeaking === false, null, { timeout: 20_000 });
  const sound = await game.evaluate(() => (window as any).__sound);
  // exactly the one voice line (Vbee audio or the computer's voice): Chibi behaviours make no sound
  expect(sound.speaks + sound.mediaPlays).toBe(1);
  expect(sound.maxAtOnce).toBe(1);
  await page.request.put("/api/v1/settings/ai", { data: { config: ai.config }, headers: H });

  // behaviour settings in the dashboard: no fun, saved and applied live
  await page.setViewportSize({ width: 1360, height: 1400 });
  await page.goto("/dashboard/game");
  const weights = page.getByTestId("chibi-weights");
  await expect(weights).toBeVisible({ timeout: 20_000 }); // a slow CI machine also renders the 3D preview
  await weights.getByLabel("Vui nhộn").fill("0");
  await page.getByRole("button", { name: "Lưu không gian & banner" }).click();
  await expect(page.getByText("Đã lưu — màn hình LIVE đổi ngay.")).toBeVisible();
  await game.waitForFunction(() => (window as any).__chibiDebug.state().behaviorConfig.weights.fun === 0, null, { timeout: 10_000 });
  await weights.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/P1-settings-behaviour.png` });
  await weights.getByRole("button", { name: "Về tỉ lệ mặc định" }).click();
  await page.getByRole("button", { name: "Lưu không gian & banner" }).click();
  await game.waitForFunction(() => (window as any).__chibiDebug.state().behaviorConfig.weights.fun === 5, null, { timeout: 10_000 });
  await game.close();
});

test("Behaviour P1 (T16): benchmark 30 and 50 Chibis from the dashboard, with level of detail", async ({ page, context }) => {
  test.setTimeout(300_000);
  const csrf = await login(page.request);
  const H = { "X-CSRF-Token": csrf };
  const game = await context.newPage();
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&overlay=1");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  await page.request.post("/api/v1/game/benchmark/clear", { headers: H });
  await page.setViewportSize({ width: 1360, height: 1500 });
  await page.goto("/dashboard/game");
  const card = page.getByTestId("perf-card");
  await expect(card.getByTestId("perf-fps")).toBeVisible({ timeout: 20_000 });
  const results: any[] = [];
  for (const n of [30, 50]) {
    await card.getByTestId(`bench-${n}`).click();
    await expect(card.getByTestId("bench-msg")).toContainText(`Đang đo với ${n} Chibi`, { timeout: 30_000 }); // slow 2-core runner
    await expect(card.getByTestId("bench-results").locator("tbody tr")).toHaveCount(results.length + 1, { timeout: 90_000 });
    const v = await (await page.request.get("/api/v1/game/perf")).json();
    const res = v.results[v.results.length - 1];
    expect(res.avatars).toBeGreaterThanOrEqual(n);
    results.push(res);
    const s = await game.evaluate(() => (window as any).__chibiDebug.state());
    // crowded: far-away Chibis are drawn with less detail; names and boxes are never dropped
    expect(s.lod.level).toBeGreaterThanOrEqual(1);
    // every Chibi has a detail level (counted on the last frame: Chibis just walking out may still be in it)
    expect(s.lod.full + s.lod.reduced + s.lod.far + s.lod.hidden).toBeGreaterThanOrEqual(s.avatars.length);
    await game.screenshot({ path: `${SHOTS}/P1-T16-game-${n}-chibi.png` });
  }
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/P1-T16-perf-card.png` });
  const fs = await import("node:fs");
  fs.writeFileSync(`${SHOTS}/P1-T16-benchmark.json`, JSON.stringify(results, null, 2));
  await card.getByTestId("bench-clear").click();
  await game.close();
});

test("High viewership: 500 events/s for 30 s — game page and dashboard stay responsive, nothing important lost", async ({ page, context }) => {
  test.setTimeout(240_000);
  const csrf = await login(page.request);
  const H = { "X-CSRF-Token": csrf };
  const errors: string[] = [];
  const game = await context.newPage();
  game.on("pageerror", (e) => errors.push(`game: ${e.message}`));
  page.on("pageerror", (e) => errors.push(`dashboard: ${e.message}`));
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&overlay=1");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().layoutVersion > 0);
  await page.setViewportSize({ width: 1360, height: 1500 });
  await page.goto("/dashboard/host");
  await expect(page.getByTestId("comment-row").first()).toBeVisible({ timeout: 20_000 }).catch(() => undefined);

  // 500 events/s: ~150 comments, ~220 likes, ~90 joins a second from 3000 viewers — far above
  // a very big shop LIVE; a few product requests a second among the chatter
  const r = await page.request.post("/api/v1/game/loadtest", { data: { rate: 500, seconds: 30, viewers: 3000, product_share: 0.02 }, headers: H });
  expect(r.ok()).toBeTruthy();
  // while the storm runs: a viewer's product comment still makes their own Chibi fetch the box
  await game.waitForTimeout(8000);
  const nick = `storm${RUN.slice(-3)}`;
  const t0 = Date.now();
  await inject(page, csrf, `@${nick}: trà cà gai leo`);
  // their Chibi comes in at once (ahead of the chatters) and goes for the box — or lines up at
  // the shelf when many others asked for the same product
  await game.waitForFunction(
    (n) => (window as any).__chibiDebug.state().avatars.some((a: any) => a.nickname === n && (a.commandId || a.top === "WAITING_SLOT")),
    nick,
    { timeout: 30_000 },
  ).catch(async (e) => {
    const st = await game.evaluate(() => (window as any).__chibiDebug.state());
    const h = await (await page.request.get("/api/v1/system/health")).json();
    console.log("STATE", JSON.stringify(st.avatars.find((a: any) => a.nickname.startsWith("storm"))), st.avatars.length, JSON.stringify(h));
    throw e;
  });
  const commandMs = Date.now() - t0;
  // the dashboard answers a click quickly in the middle of the storm
  const c0 = Date.now();
  await page.getByRole("link", { name: "Tổng quan" }).click();
  await expect(page.getByRole("heading", { name: "Tổng quan" }).first()).toBeVisible();
  const clickMs = Date.now() - c0;
  await page.goto("/dashboard/game");
  const card = page.getByTestId("server-health");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/LOAD-server-health-during-storm.png` });
  await game.screenshot({ path: `${SHOTS}/LOAD-game-during-storm.png` });
  // wait for the end and the backlog to clear
  await expect.poll(async () => {
    const h = await (await page.request.get("/api/v1/system/health")).json();
    return h.loadtest?.done && h.server.bus_depth === 0;
  }, { timeout: 60_000 }).toBe(true);
  const h = await (await page.request.get("/api/v1/system/health")).json();
  const m = await (await page.request.get("/api/v1/metrics")).json();
  const fps: number[] = await game.evaluate(() => (window as any).__chibiDebug.fps());
  const s = await game.evaluate(() => (window as any).__chibiDebug.state());
  const summary = { sent: h.loadtest.sent, achieved: h.loadtest.achieved_rate, server: h.server, commandMs, clickMs,
    gameFpsLast: fps.slice(-10), avatars: s.avatars.length, socketsKicked: m.errors, comments: m.events.COMMENT };
  const fs = await import("node:fs");
  fs.writeFileSync(`${SHOTS}/LOAD-summary.json`, JSON.stringify(summary, null, 2));
  expect(h.loadtest.sent).toBeGreaterThan(14_000);
  // generous on a 2-core CI runner that also draws the 3D shop in software; typically ~8 s / ~1 s
  expect(commandMs).toBeLessThan(30_000);
  expect(clickMs).toBeLessThan(10_000);
  // never more than the on-screen cap, apart from Chibis already walking out of the door
  expect(s.avatars.filter((a: any) => a.top !== "LEAVING").length).toBeLessThanOrEqual(60);
  expect(errors).toEqual([]);
  await expect(page.getByTestId("server-level")).toContainText("Ổn định", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/LOAD-server-health-after.png` });
  await page.request.post("/api/v1/game/benchmark/clear", { headers: H });
  await game.close();
});

test("Stage + owner talk: first to comment dances first, the owner answers chat itself, recites a poem", async ({ page, context }) => {
  test.setTimeout(200_000);
  const csrf = await login(page.request);
  const H = { "X-CSRF-Token": csrf };
  const scene = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
  await page.request.put("/api/v1/settings/scene", { data: { ...scene, owner_enabled: true, stage_enabled: true, stage_seconds: 25, stage_side: "center", levels_enabled: false }, headers: H });
  const s = await (await page.request.get("/api/v1/settings/ai")).json();
  const cfg = { ...s.config, voice_policy_confirmed: true, voice_enabled: true, autopilot: false, read_comments: false, greet_joins: false, owner_chat: true, stage_announce: true, poem_story: true, poem_auto: false, poem_story_builtin: true, poem_story_claude: false };
  const put = await page.request.put("/api/v1/settings/ai", { data: { config: cfg }, headers: H });
  expect(put.ok(), await put.text()).toBeTruthy();
  await page.request.post("/api/v1/voice/unmute", { headers: H });
  await page.request.post("/api/v1/stage/clear", { headers: H });
  await page.request.post("/api/v1/stage/skip", { headers: H });
  // small talk is the first thing dropped while the server is busy: start once it has calmed down
  await expect.poll(async () => {
    const h = await (await page.request.get("/api/v1/system/health")).json();
    return h.server?.level ?? h.level;
  }, { timeout: 90_000 }).toBe("ok");

  const game = await context.newPage();
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&quality=medium");
  await game.waitForFunction(() => (window as any).__chibiDebug?.state().stageSpot, null, { timeout: 30_000 });
  const board = game.getByTestId("stage-board");
  const bubble = game.getByTestId("owner-bubble");
  // the stage stands in the middle of the shop, in the middle of the picture
  const spot = await game.evaluate(() => (window as any).__chibiDebug.state().stageSpot);
  expect(spot.shape).toBe("round");
  expect(spot.x).toBe(0);
  await game.waitForTimeout(1500);
  await game.screenshot({ path: `${SHOTS}/STAGE-0-center-idle.png` });

  // three viewers ask to dance; the first one is called up first, the others wait in order
  const [a, b, c] = ["mai", "tung", "linh"].map((n) => `${n}${RUN}`);
  await inject(page, csrf, `@${a}: cho mình lên sân khấu nhảy với`);
  await inject(page, csrf, `@${b}: nhảy`);
  await inject(page, csrf, `@${c}: đăng ký nhảy`);
  await inject(page, csrf, `@${b}: nhảy`); // asking twice keeps the place
  await expect(board.getByTestId("stage-current")).toContainText(a, { timeout: 20_000 });
  await expect(board.getByTestId("stage-next")).toContainText(b);
  const next = await board.getByTestId("stage-next").innerText();
  expect(next.indexOf(b)).toBeLessThan(next.indexOf(c));
  expect(next.split(b).length - 1).toBe(1);
  await expect(bubble).toContainText(`Mời bạn ${a} lên sân khấu`, { timeout: 40_000 }); // after any line the voice is still reading

  // the Chibi walks to the stage, climbs up and dances under the lights
  await expect(board.getByTestId("stage-current")).toHaveAttribute("data-phase", "dancing", { timeout: 40_000 });
  await game.waitForFunction((n) => {
    const st = (window as any).__chibiDebug.state();
    const av = st.avatars.find((x: any) => x.nickname === n);
    return av && av.elevation > 0.2 && av.phase === "stage_dance";
  }, a, { timeout: 15_000 });
  // the camera frames the stage while they dance
  await game.waitForFunction(() => (window as any).__chibiCamera?.shot === "stage", null, { timeout: 10_000 });
  await game.waitForTimeout(1500);
  await game.screenshot({ path: `${SHOTS}/STAGE-1-dancing.png` });

  // the host sees the line on the dashboard
  await page.setViewportSize({ width: 1360, height: 1200 });
  await page.goto("/dashboard/host");
  const card = page.getByTestId("stage-card");
  await expect(card.getByTestId("stage-card-current")).toContainText(a);
  await expect(card.getByTestId("stage-queue")).toContainText(c);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/STAGE-2-host.png` });

  // after their turn: thanks, they step down, and the next one is called
  await expect(board.getByTestId("stage-current")).toContainText(b, { timeout: 60_000 });
  await game.waitForFunction((n) => {
    const av = (window as any).__chibiDebug.state().avatars.find((x: any) => x.nickname === n);
    return av && av.elevation === 0 && !String(av.phase).startsWith("stage");
  }, a, { timeout: 20_000 });
  await card.getByRole("button", { name: "Xóa hàng chờ" }).click();
  await expect(card.getByTestId("stage-queue")).toHaveCount(0);
  await expect(card.getByTestId("stage-card-current")).toContainText(b); // still dancing
  await card.getByRole("button", { name: "Cho xuống / bỏ lượt" }).click();
  await expect(card.getByTestId("stage-card-current")).toHaveCount(0, { timeout: 10_000 });

  // small talk: the owner reads it and answers by itself (no Claude) — only on the voice:
  // no bubble, no caption text on screen (default "chat_on_screen": off)
  const caption = game.getByTestId("speech-caption");
  await inject(page, csrf, `@khen${RUN}: hôm nay shop đẹp quá`);
  await expect(caption).toContainText(`khen${RUN}`, { timeout: 25_000 });
  await expect(caption).toHaveAttribute("data-kind", "comment");
  await expect(caption).toHaveAttribute("data-hidden", "1");
  await expect(caption).toBeHidden();
  await expect(caption).toHaveAttribute("data-kind", "answer", { timeout: 30_000 }); // the owner's own reply follows the reading
  await expect(caption).toContainText("cảm ơn");
  await expect(caption).toBeHidden();
  await expect(bubble.filter({ hasText: `khen${RUN}` })).toHaveCount(0);
  await game.screenshot({ path: `${SHOTS}/CHAT-1-only-voice.png` });
  // the shop can turn the text back on (Game 3D & OBS → Không gian cửa hàng)
  const sc = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
  await page.request.put("/api/v1/settings/scene", { data: { ...sc, chat_on_screen: true }, headers: H });
  await game.waitForTimeout(16_000); // small talk is answered at most once every 15 s
  await inject(page, csrf, `@khen2${RUN}: live vui ghê, ủng hộ shop nha`);
  await expect(bubble).toContainText(`khen2${RUN}`, { timeout: 30_000 });
  await expect(caption).toBeVisible();
  await expect(caption).toHaveAttribute("data-kind", "answer", { timeout: 30_000 }); // and the owner's reply, on screen too
  await expect(caption).toBeVisible();
  await expect(bubble).not.toContainText("nói:");
  await game.screenshot({ path: `${SHOTS}/STAGE-3-owner-answers.png` });
  await page.request.put("/api/v1/settings/scene", { data: { ...sc, chat_on_screen: false }, headers: H });

  // a viewer asks for a poem → the owner recites one for them
  await inject(page, csrf, `@tho${RUN}: làm thơ đi shop`);
  await expect(bubble).toHaveAttribute("data-kind", "poem", { timeout: 40_000 });
  await expect(bubble).toContainText(`tho${RUN}`);
  await game.waitForTimeout(600);
  await game.screenshot({ path: `${SHOTS}/STAGE-4-poem.png` });

  // the settings page has the owner-talk section and the "read a story now" button
  await page.goto("/dashboard/ai");
  const talk = page.getByTestId("owner-talk-card");
  await expect(talk).toBeVisible();
  // the owner makes up a poem every 10–15 minutes (random in between)
  await expect(talk.getByLabel("Làm thơ sau ít nhất (phút)")).toHaveValue("10");
  await expect(talk.getByLabel("Làm thơ sau nhiều nhất (phút)")).toHaveValue("15");
  await talk.getByRole("button", { name: "Kể chuyện ngay" }).click();
  await expect(talk.getByTestId("talk-now-msg")).toContainText("câu chuyện");
  await expect(bubble).toHaveAttribute("data-kind", "story", { timeout: 60_000 });
  await game.screenshot({ path: `${SHOTS}/STAGE-5-story.png` });
  await talk.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/STAGE-6-settings.png` });

  await page.request.put("/api/v1/settings/ai", { data: { config: { ...cfg, voice_enabled: false } }, headers: H });
  await game.close();
});

test("Sharp LIVE picture: 'Nét nhất' draws twice the pixels; the dashboard says whether the window fills the 1080 × 1920 frame", async ({ page, context }) => {
  test.setTimeout(150_000);
  const csrf = await login(page.request);
  await inject(page, csrf, `@net${RUN}: chào shop`);
  const game = await context.newPage();
  // a small window (as on a Full HD monitor): ultra draws 2× but the window itself is too small for LIVE
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?quality=ultra");
  await game.waitForFunction(() => (window as any).__chibiRender?.quality === "ultra", null, { timeout: 30_000 });
  let r = await game.evaluate(() => (window as any).__chibiRender);
  expect([r.width, r.height]).toEqual([1080, 1920]);
  await page.setViewportSize({ width: 1360, height: 1400 });
  await page.goto("/dashboard/game");
  const sharp = page.getByTestId("perf-sharpness");
  await expect(sharp).toHaveAttribute("data-sharp", "0", { timeout: 20_000 });
  await expect(sharp).toContainText("540 × 960");
  await expect(sharp).toContainText("Nét nhất cho LIVE");
  await expect(page.getByTestId("sharp-url")).toContainText("/game/live?quality=ultra");
  await sharp.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/SHARP-1-dashboard-small-window.png` });

  // the full LIVE frame: 1080 × 1920 window, drawn at 2160 × 3840
  await game.setViewportSize({ width: 1080, height: 1920 });
  await game.waitForFunction(() => (window as any).__chibiRender?.height === 3840, null, { timeout: 20_000 });
  r = await game.evaluate(() => (window as any).__chibiRender);
  expect([r.width, r.height, r.cssWidth, r.cssHeight]).toEqual([2160, 3840, 1080, 1920]);
  await expect(sharp).toHaveAttribute("data-sharp", "1", { timeout: 20_000 });
  await expect(sharp).toContainText("vẽ ở 2160 × 3840");
  await game.waitForTimeout(1500);
  await game.screenshot({ path: `${SHOTS}/SHARP-2-ultra-1080x1920.png` });

  // the same frame at the old default ("vừa" = 1× on a normal PC screen) for comparison
  await game.goto("/game/live?quality=medium");
  await game.waitForFunction(() => (window as any).__chibiRender?.quality === "medium", null, { timeout: 30_000 });
  r = await game.evaluate(() => (window as any).__chibiRender);
  expect([r.width, r.height]).toEqual([1080, 1920]);
  await game.waitForTimeout(1500);
  await game.screenshot({ path: `${SHOTS}/SHARP-3-medium-1080x1920.png` });
  await game.close();
});

test("Chibi levels: staying longer dresses up the Chibi (nón lá → áo choàng → vương miện), the owner congratulates", async ({ page, context }) => {
  test.setTimeout(150_000);
  const csrf = await login(page.request);
  const H = { "X-CSRF-Token": csrf };
  const scene = (await (await page.request.get("/api/v1/settings/scene")).json()).config;
  await page.request.put("/api/v1/settings/scene", { data: { ...scene, owner_enabled: true, levels_enabled: true, level_minutes: [5, 15, 30], stage_enabled: true }, headers: H });
  const who = `lenCap${RUN}`;
  await inject(page, csrf, `@${who}: chào shop`);
  const game = await context.newPage();
  await game.setViewportSize({ width: 540, height: 960 });
  await game.goto("/game/live?debug=1&quality=high");
  await game.waitForFunction((n) => (window as any).__chibiDebug?.state().avatars.some((a: any) => a.nickname === n), who, { timeout: 30_000 });
  // viewers are told how it works (shown a quarter of every minute)
  await expect(game.getByTestId("level-hint")).toContainText("5 phút: nón lá");
  await expect(game.getByTestId("level-hint")).toContainText("30 phút: vương miện");

  await page.setViewportSize({ width: 1360, height: 1200 });
  await page.goto("/dashboard/host");
  const card = page.getByTestId("levels-card");
  await expect(card).toContainText("cấp 1 sau 5 phút (nón lá)");
  const bubble = game.getByTestId("owner-bubble");
  const levelOf = () => game.evaluate((n) => (window as any).__chibiDebug.state().avatars.find((a: any) => a.nickname === n)?.level, who);
  const shot = async (name: string) => {
    await game.waitForTimeout(1200);
    const box = await game.evaluate((n) => {
      const st = (window as any).__chibiDebug.state();
      const id = st.avatars.find((a: any) => a.nickname === n)?.id;
      return (window as any).__chibiLabels?.boxes.find((b: any) => b.id === id) ?? null;
    }, who);
    const clip = box ? { x: Math.max(0, box.x - 90), y: Math.max(0, box.y - 40), width: 180, height: 200 } : undefined;
    await game.screenshot({ path: `${SHOTS}/${name}.png`, clip });
  };
  await shot("LEVEL-0");
  const items = ["nón lá", "áo choàng", "vương miện"];
  for (let lvl = 1; lvl <= 3; lvl++) {
    const r = await page.request.post("/api/v1/levels/try", { data: { name: who }, headers: H });
    expect(r.ok(), await r.text()).toBeTruthy();
    await expect.poll(levelOf, { timeout: 15_000 }).toBe(lvl);
    await expect(bubble).toContainText(`Chibi được ${lvl === 2 ? "khoác" : "đội"} ${items[lvl - 1]}`, { timeout: 10_000 });
    await shot(`LEVEL-${lvl}`);
    await game.waitForTimeout(lvl < 3 ? 5500 : 0); // let the bubble go before the next one
  }
  await expect(card).toContainText(who, { timeout: 15_000 });
  await expect(card.locator(".lv-badge.lv3")).toHaveCount(1);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/LEVEL-host.png` });
  // with the crown and the cape on the stage (close-up)
  await page.request.post("/api/v1/stage/clear", { headers: H });
  await page.request.post("/api/v1/stage/skip", { headers: H });
  await inject(page, csrf, `@${who}: nhảy`);
  await expect(game.getByTestId("stage-current")).toHaveAttribute("data-phase", "dancing", { timeout: 45_000 });
  await game.waitForTimeout(2500);
  await game.screenshot({ path: `${SHOTS}/LEVEL-stage.png` });
  await game.close();
});
