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
| M2 | Editor kéo-thả kệ, GLB sản phẩm, sao lưu/khôi phục, bộ dữ liệu bình luận tiếng Việt, nhãn tên không đè nhau | **Phần lớn xong** — còn Chibi GLB có xương và benchmark trên PC thật |
| M3 | Kết nối TikTok LIVE thật (TikTokLive, link rút gọn, kết nối lại, khóa Euler tùy chọn) | **Code xong, chưa thử LIVE thật** — làm theo `docs/provider-limitations.md` |
| M4 | Claude AI + ngân sách + giọng đọc Vbee | **Code xong, chưa thử với key thật** — bình luận tên sản phẩm vẫn chạy bằng bộ luật (0 USD); chỉ câu hỏi mới gọi Claude |
| M5 | OBS & vận hành | Một phần (Browser Source dùng được, hướng dẫn trong `docs/obs-setup.md`) |
| M6 | Đơn hàng TikTok Shop | Chưa làm — trạng thái `Not configured` |

## Chạy thử trên Windows

Cần **Python 3.12+** và **Node.js 20+**.

```powershell
git clone https://github.com/junsu123/TapHoaAi.git
cd TapHoaAi
powershell -ExecutionPolicy Bypass -File scripts\dev_windows.ps1
```

Server chạy ở cổng **8686** (không dùng 8000). Đổi cổng: `scripts\dev_windows.ps1 -Port 9090`; nếu cổng bận, script tự chọn cổng trống kế tiếp và in địa chỉ ra màn hình. Lần chạy sau không cần cài lại: thêm `-SkipInstall`.

1. Mở `http://127.0.0.1:8686/dashboard` → lần đầu tạo tài khoản quản trị (chỉ làm được trên chính máy này).
2. Mở `http://127.0.0.1:8686/game/live` ở cửa sổ thứ hai (đây là **cửa sổ game chính**; chỉ mở một cái).
3. Dashboard → **Người trực & Demo** → bấm `@lananh88: trà cà gai leo`.

Chibi “lananh88” đi tới Kệ 2, nhặt hộp trà cà gai leo, quay ra camera 8 giây, rồi trả hộp về kệ. Bấm `@khachle: trà` để thấy bình luận mơ hồ được chuyển cho người trực thay vì đoán.

## Chạy trên Linux/macOS (phát triển)

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]" && cd ..
cd frontend && npm install && npm run build && cd ..
backend/.venv/bin/python scripts/seed_demo.py --admin chu_shop --password "mat-khau-du-dai"
cd backend && .venv/bin/python -m app            # hoặc: python -m app --port 9090
```

Phát triển giao diện có hot-reload: chạy backend như trên, rồi `cd frontend && npm run dev` (Vite proxy `/api`, `/ws`, `/media` về cổng `CHIBI_PORT`, mặc định 8686) và mở `http://127.0.0.1:5173`.

## Kiểm thử

```bash
cd backend && .venv/bin/pytest -q                 # 142 test: matcher, queue, camera, API, WebSocket, reconnect, editor, backup, TikTok adapter
cd frontend && npx vitest run                     # 17 test: A*, FSM, pickup/show, kệ xoay, sequence, nhãn tên
cd frontend && npx playwright test                # 11 test trình duyệt thật (WebGL) + ảnh minh chứng
cd backend && .venv/bin/python -m app.eval_matcher tests/fixtures/comments_vi.csv   # đo độ chính xác nhận diện
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

## Hộp sản phẩm trông như thật

Dashboard → Sản phẩm → chọn sản phẩm → mục **Hộp sản phẩm trông thật**:

1. Nhập kích thước thật (cm), ví dụ 12 × 17 × 5,2.
2. "Ảnh chính" là mặt trước hộp; tải thêm ảnh mặt trái/phải/sau/nắp nếu có.
3. Chọn màu nền cho các mặt chưa có ảnh.
4. "Ảnh thẻ sản phẩm" là ảnh hiện trên thẻ khi Chibi giới thiệu (ảnh 3D mockup rất hợp).

### Lấy tất cả các mặt từ file in PDF (khuyên dùng)

Bấm **📄 Lấy tất cả các mặt từ file in PDF…**, nhập kích thước thật (cm) rồi chọn file PDF đã gửi nhà in (≤ 80 MB, ≤ 30 trang):

- File trải phẳng (dieline) một trang: phần mềm đặt sẵn 6 khung màu đúng cỡ thật theo kiểu hộp phổ biến (trái–trước–phải–sau, nắp trên phía trên mặt trước, đáy phía dưới). Kéo khung vào đúng mặt nếu file của bạn xếp khác; khung tự hít vào mép khung bên cạnh, phím mũi tên để nhích từng chút.
- File mỗi mặt một trang: phần mềm tự ghép trang với mặt theo kích thước.
- Mặt in nằm ngang hoặc ngược: bấm ⟳ đến khi ảnh nhỏ bên phải đứng thẳng.
- Bấm **Cắt ảnh các mặt đã chọn** → xem hộp 3D (kéo để xoay) → **Dùng các mặt này** → **Lưu**.

File PDF chỉ lưu trong `data/pdf_imports` (không công khai qua `/media`) và tự xóa sau 7 ngày. Màu của file in hệ CMYK được đổi sang màn hình nên có thể lệch nhẹ so với hộp in.

### Chỉ có ảnh mockup 3D

Cắt ra ảnh phẳng:

```
python scripts/unwarp_box.py mockup.jpg --front x1 y1 x2 y2 x3 y3 x4 y4 --left ... --size 12x17x5.2 --out faces
```

Toạ độ là 4 góc của mặt đó trên ảnh (trên-trái, trên-phải, dưới-phải, dưới-trái), đọc bằng Paint hoặc bất kỳ trình xem ảnh nào.

## Trợ lý AI & giọng đọc (Claude + Vbee)

Dashboard → **Trợ lý AI & giọng đọc**:

1. **Claude API key** (console.anthropic.com → API Keys), model `claude-haiku-5-5` (rẻ nhất, đủ cho câu trả lời ngắn), hạn mức USD/ngày và /tháng. Bấm **Thử kết nối Claude** để xem một câu trả lời mẫu và chi phí.
2. **Thông tin chung của shop**: ship, thanh toán, đổi trả… AI chỉ được dùng thông tin ở đây và trong danh mục sản phẩm (giá đã xác nhận, công bố, lưu ý) — không bịa.
3. **Vbee**: App ID, Token (tạo ứng dụng trong trang API của vbee.vn), mã giọng (mặc định `hn_female_ngochuyen_full_48k-fhg` – HN Ngọc Huyền), tốc độ, hạn mức ký tự/tháng. Bấm **Nghe thử trên máy này**.
4. **Phát giọng trên LIVE**: đánh dấu 4 mục chính sách → **Bật giọng đọc trên LIVE**. Chọn câu trả lời được đọc khi **người trực bấm “Đọc”** (mặc định) hoặc **tự động** (chỉ câu an toàn).
5. OBS: Browser Source đánh dấu **Control audio via OBS** (xem `docs/obs-setup.md`).

Khi LIVE, trang **Người trực & Demo**:

- Khách hỏi (có dấu “?”, “giá bao nhiêu”, “ship không”…) → phần mềm đọc “Bạn {tên} hỏi: …” (bỏ số điện thoại, liên kết, từ cấm) → Claude soạn câu trả lời → bấm **🔊 Đọc**, **✏️ Sửa rồi đọc** hoặc **Bỏ qua**. Màn hình LIVE hiện phụ đề “Câu hỏi của khách” / “🤖 Trợ lý AI”.
- **⏹ Tắt giọng ngay (F9)**: dừng tức thì, không đọc gì nữa đến khi bấm “Bật lại giọng”. **Giữ để nói (Space)** hoặc **Tự im khi micro có tiếng**: AI không nói đè người dẫn.
- **⏸ Tạm dừng AI (Ctrl+Shift+P)**: không gọi Claude, không phát giọng; game vẫn chạy.

An toàn: bình luận là dữ liệu, không phải lệnh cho AI; tên khách không gửi lên Claude; AI chỉ chọn mã sản phẩm trong danh mục; câu nói về bệnh/chữa trị, giá không có trong danh mục, hoặc AI không chắc chắn **không bao giờ tự đọc**. Hết hạn mức: game vẫn chạy, câu hỏi giá dùng câu mẫu lấy từ danh mục. Chi phí ước tính với Haiku 5.5: khoảng 0,02 cent mỗi câu hỏi.

### Hội thoại & câu đã học

- Mọi câu hỏi trong LIVE được lưu: lúc nào, khách nào, câu hỏi (đã bỏ số điện thoại/liên kết), gợi ý, câu trả lời cuối, ai trả lời (Claude / người trực / câu đã học / câu mẫu), đã đọc chưa, chi phí. Xem và tải CSV (mở bằng Excel) ở **Hội thoại & câu đã học → Lịch sử hội thoại LIVE**. Tên khách tự xóa sau `CHIBI_EVENT_RETENTION_DAYS` ngày (mặc định 7), câu hỏi/câu trả lời giữ lại để học.
- **Học từ LIVE**: mỗi câu trả lời người trực bấm “Đọc” được nhớ cùng cách hỏi. Lần sau khách hỏi câu giống (hiểu viết tắt bn, ko, sp, ntn, sốp…; bỏ “shop ơi”, “ạ”, “nha”…; độ giống mặc định ≥ 75 %) → **tự trả lời ngay, không gọi Claude**. Câu hỏi giá cũng tự trả lời bằng giá đã xác nhận trong danh mục.
- Giá trong câu đã học được lưu dạng ‹giá hiện tại›: đổi giá sản phẩm thì câu trả lời đổi theo; giá mới chưa xác nhận thì câu đó tạm không dùng. Câu nói về tồn kho không được học; câu có “khuyến mãi”, “hôm nay”, “còn hàng”… và câu Claude tự đọc (chế độ tự động) chỉ ở dạng **chờ duyệt** cho đến khi bạn bấm Duyệt.
- Trong trang câu đã học: sửa câu trả lời, thêm cách hỏi khác, tắt/xóa, tự thêm câu trả lời mẫu, ô **Thử một câu hỏi** để xem LIVE sẽ tự trả lời gì. Từ lịch sử, bấm **Lưu thành câu đã học** cho câu nào muốn dạy lại.

`CHIBI_TTS_LOCKED=1` khóa giọng đọc bất kể dashboard. `CHIBI_FAKE_AI=1` dùng Claude/giọng giả (tiếng bíp) để demo và kiểm thử không tốn tiền.

## Kết nối TikTok LIVE

Dashboard → **Kết nối TikTok** → dán link LIVE (hoặc link `vm.tiktok.com`) → đánh dấu danh sách chính sách → **Kết nối**. Trước khi dùng cho buổi bán hàng, làm bài thử 9 bước trong [`docs/provider-limitations.md`](docs/provider-limitations.md) — trong đó có tóm tắt giấy phép TikTokLive (dùng cho cửa hàng của bạn được; **không** đem làm dịch vụ SaaS cho người khác) và việc tên tài khoản LIVE được gửi tới máy chủ ký Euler Stream.

Khi người xem rời LIVE: TikTok không báo ai đã thoát, nên Chibi rời cửa hàng khi người đó không tương tác trong vài phút (chỉnh ở Dashboard → Game 3D & OBS), khi số người xem giảm, hoặc khi LIVE kết thúc.

## Sao lưu

- Dashboard → **Cài đặt & sao lưu** → *Sao lưu ngay* (tải về file .zip), hoặc `python scripts/backup_db.py backup`.
- Khôi phục: **tắt server**, rồi `python scripts/backup_db.py restore data\backups\<file>.zip` (tự sao lưu dữ liệu cũ trước).
- File `data/secret.key` không nằm trong bản sao lưu — hãy cất riêng.

## Nguyên tắc an toàn đã áp dụng

- Không giả sự kiện, không giả số người xem, không báo kết nối/đơn hàng khi chưa xác nhận.
- Bình luận là dữ liệu không tin cậy: chỉ hiển thị dạng chữ, không bao giờ thành lệnh hệ thống.
- Giá chỉ hiện khi người quản trị đã xác nhận; đổi giá → phải xác nhận lại.
- Hộp 3D dùng đúng ảnh mặt trước đã duyệt; các mặt khác để màu trơn, không bịa nội dung.
- Ảnh sản phẩm trong `assets/sample-products/` là **hàng mẫu DEMO** của cửa hàng hư cấu “Tạp Hóa Chibi” — thay bằng ảnh thật trước khi LIVE.
