# Chibi AI TikTok Live Shop

Phần mềm cho cửa hàng bán hàng qua TikTok LIVE: khán giả bình luận tên sản phẩm → một nhân vật **Chibi 3D** mang nickname của họ đi tới đúng kệ, **cầm đúng hộp sản phẩm**, giơ lên camera và hiện thẻ thông tin đã duyệt. Người thật vẫn là người bán chính; AI (Claude, mốc M4) chỉ soạn gợi ý cho người trực.

- Đặc tả gốc: [`SPEC.md`](SPEC.md)
- Tài liệu thiết kế: [Thiết kế phần mềm — Chibi AI TikTok Live Shop](https://claude.ai/artifact/7rgEmSkhoP93KMGsxd2xEG)
- Kế hoạch & tiến độ: [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) · Nghiệm thu: [`docs/acceptance-report.md`](docs/acceptance-report.md)

## Trạng thái

| Mốc | Nội dung | Trạng thái |
| --- | --- | --- |
| M0 | Nền tảng: backend, DB + migration, đăng nhập, Demo provider, event contract, CI | **Xong** |
| M1 | Vertical slice: bình luận → Chibi đi → cầm hộp → camera cận cảnh → trả hộp | **Xong** (6 kệ, 2 sản phẩm mẫu) |
| M2 | Editor kéo-thả kệ, GLB, backup, bộ dữ liệu tiếng Việt để tinh chỉnh ngưỡng | Chưa làm |
| M3 | Kết nối TikTok LIVE thật | Chưa làm — hiện báo **“Không hỗ trợ”**, không bao giờ giả “Đã kết nối” |
| M4 | Claude AI + ngân sách | Chưa làm — mọi bình luận sản phẩm chạy bằng bộ luật, 0 USD |
| M5 | OBS & vận hành | Một phần (Browser Source dùng được, hướng dẫn trong `docs/obs-setup.md`) |
| M6 | Đơn hàng TikTok Shop | Chưa làm — trạng thái `Not configured` |

## Chạy thử trên Windows

Cần **Python 3.12+** và **Node.js 20+**.

```powershell
git clone https://github.com/junsu123/TapHoaAi.git
cd TapHoaAi
powershell -ExecutionPolicy Bypass -File scripts\dev_windows.ps1
```

1. Mở `http://127.0.0.1:8000/dashboard` → lần đầu tạo tài khoản quản trị (chỉ làm được trên chính máy này).
2. Mở `http://127.0.0.1:8000/game/live` ở cửa sổ thứ hai (đây là **cửa sổ game chính**; chỉ mở một cái).
3. Dashboard → **Người trực & Demo** → bấm `@lananh88: trà cà gai leo`.

Chibi “lananh88” đi tới Kệ 2, nhặt hộp trà cà gai leo, quay ra camera 8 giây, rồi trả hộp về kệ. Bấm `@khachle: trà` để thấy bình luận mơ hồ được chuyển cho người trực thay vì đoán.

## Chạy trên Linux/macOS (phát triển)

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]" && cd ..
cd frontend && npm install && npm run build && cd ..
backend/.venv/bin/python scripts/seed_demo.py --admin chu_shop --password "mat-khau-du-dai"
cd backend && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Phát triển giao diện có hot-reload: chạy backend như trên, rồi `cd frontend && npm run dev` (Vite proxy `/api`, `/ws`, `/media` về cổng 8000) và mở `http://127.0.0.1:5173`.

## Kiểm thử

```bash
cd backend && .venv/bin/pytest -q                 # 94 test: matcher, queue, camera, API, WebSocket, reconnect
cd frontend && npx vitest run                     # 13 test: A*, FSM, pickup/show, sequence, nhãn tên
cd frontend && npx playwright test                # 6 test trình duyệt thật (WebGL) + ảnh minh chứng
```

Playwright tự khởi động backend sạch qua `scripts/e2e_server.sh`. Ảnh minh chứng nằm ở `frontend/test-results/evidence/` (bản đã chụp: `docs/evidence/`).

## Cấu trúc

```text
backend/app/
  providers/   live_provider (interface) · demo_adapter · tiktoklive_adapter (M3) · url_validator
  events/      schema (F1) · normalizer · deduper (+ gift streak) · bus
  services/    catalog · product_matcher · intent_router · avatar_manager · action_queue
               camera_director · orchestrator · live_session · media · shop_integration
  api/v1/      auth · live (+demo) · catalog (products, aliases, assets, shelves) · system
  websocket/   hub (sequence + snapshot) · routes (/ws/game, /ws/dashboard)
frontend/src/
  game/        GameEngine · AvatarController · AnimationFSM · Navigation (A*) · World · ChibiAvatar
               StoreScene · ProductBox · LiveOverlay · GamePage
  dashboard/   DashboardApp · useDashboardFeed
  lib/         api · ws (SequencedSocket)
```

## Nguyên tắc an toàn đã áp dụng

- Không giả sự kiện, không giả số người xem, không báo kết nối/đơn hàng khi chưa xác nhận.
- Bình luận là dữ liệu không tin cậy: chỉ hiển thị dạng chữ, không bao giờ thành lệnh hệ thống.
- Giá chỉ hiện khi người quản trị đã xác nhận; đổi giá → phải xác nhận lại.
- Hộp 3D dùng đúng ảnh mặt trước đã duyệt; các mặt khác để màu trơn, không bịa nội dung.
- Ảnh sản phẩm trong `assets/sample-products/` là **hàng mẫu DEMO** của cửa hàng hư cấu “Tạp Hóa Chibi” — thay bằng ảnh thật trước khi LIVE.
