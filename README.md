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

## Không gian tiệm trà & banner sản phẩm

Trang **Game 3D & OBS** → thẻ **🍵 Không gian cửa hàng & banner sản phẩm**:

- **Kiểu cửa hàng:** *Tiệm trà thảo mộc* (mặc định: sàn gỗ, vách tre, kệ gỗ với hũ thảo mộc và chum đất, đèn lồng, chậu tre, thúng thảo mộc, quầy trà có ấm chén, biển hiệu gỗ chữ vàng) hoặc *Tạp hóa Chibi* (kiểu hồng cũ).
- **Biển hiệu:** chữ chính và dòng phụ (VD “Trà sạch · Thảo mộc Việt”).
- **Banner ảnh sản phẩm:** khung lớn ở đầu màn hình LIVE, ảnh sản phẩm hiện nguyên vẹn, nét theo đúng độ phân giải ảnh (không qua 3D), kèm tên và giá đã xác nhận. Hai cách chạy: **chạy liên tục** (mặc định — ảnh trượt ngang không ngừng như băng chuyền, chỉnh tốc độ 2–30 giây cho mỗi sản phẩm) hoặc **lần lượt** (mỗi lần một sản phẩm thật to). Khi Chibi cầm sản phẩm ra cho khách xem, banner dừng lại và chỉ hiện sản phẩm đó với dòng “👀 tên khách đang xem” (tắt tùy chọn này thì banner vẫn chạy, sản phẩm đó được viền đỏ). Chọn chiều cao (15–40% màn hình) và các sản phẩm được hiện (không chọn = mọi sản phẩm có ảnh). Ảnh dùng là *ảnh thẻ sản phẩm* nếu có, nếu không thì ảnh mặt trước.
- **Ảnh trên tường:** hai khung ảnh sản phẩm treo sau quầy trong cảnh 3D (thấy rõ khi tắt banner).

Lưu là màn hình LIVE (và khung xem trước) đổi ngay, không cần tải lại OBS.

## Chủ quán, màn hình LED sản phẩm & bảng vàng

Trên màn hình LIVE (đổi trong thẻ **Không gian cửa hàng & banner sản phẩm**, trang Game 3D & OBS):

- **Màn hình LED gắn cố định trên tường:** ảnh sản phẩm chạy trên một màn hình LED lớn gắn phẳng lên tường sau quầy, nằm trong cảnh 3D (Chibi đi trước màn hình, không che hình LIVE). Chạy liên tục hoặc lần lượt; khi Chibi cầm sản phẩm ra, LED chỉ hiện sản phẩm đó kèm tên khách. Màn hình chỉ bật/tắt, không kéo đi chỗ khác (các kiểu *tivi* / *bảng gỗ* nổi trên màn hình LIVE trước đây đã bỏ; cài đặt cũ tự chuyển sang màn LED).
- **Nhân vật Chibi:** to gấp khoảng 1,45 lần bản đầu nên nhìn rõ cả trong cảnh toàn quán. Mặt vẽ kiểu anime (mắt to có tròng màu, ánh sáng long lanh, mi mắt, má hồng), có biểu cảm theo động tác: chớp mắt, cười híp mắt khi nhảy / ăn mừng / cổ vũ, há miệng cười khi cầm hàng, tròn mắt khi ngạc nhiên, ngáp. Tóc có mái, kiểu tóc bob dày ở sau; có giày, cạp quần, huy hiệu nhỏ trên ngực; viền sáng nhẹ quanh dáng người và bóng tròn mềm dưới chân. Đường đi, chỗ đứng, chỗ ngồi không đổi; camera cận cảnh lùi theo cỡ nhân vật, hộp hàng trên tay to lên một chút cho dễ đọc. Chủ quán cũng vậy, miệng mấp máy khi nói, cười híp mắt khi cúi chào.
- **Chibi chủ quán:** ngồi pha trà ở bàn trà giữa quán. Có người vào LIVE, chủ quán đứng dậy, cúi chào và hiện bong bóng “Xin chào quý khách {tên} đã vào quán!”. Nhiều người vào cùng lúc được gộp tên (3 tên một bong bóng, đông quá thì “… và N bạn khác”); mỗi người chỉ được chào một lần trong 10 phút. Bong bóng hiện cả khi chưa bật giọng đọc.
- **Mời trà khách tặng quà:** Chibi của khách tặng quà đi tới ngồi đối diện chủ quán; chủ quán rót trà, mời nước (“Mời {tên} dùng trà ạ! Cảm ơn {tên} đã tặng {quà}!”), camera quay cận bàn trà vài giây. Khách ngồi khoảng 12 giây rồi đứng dậy đi tiếp; nhiều người tặng quà thì lần lượt từng người.
- **Bảng vàng:** top người tặng quà (theo số xu, không rõ xu thì theo số quà) và top người mua hàng, hai bảng thay phiên nhau ở góc dưới màn hình. Tính theo từng buổi LIVE hoặc mọi buổi LIVE. Đơn mua hàng do người trực **ghi nhận** (thẻ Bảng vàng ở trang Người trực, hoặc nút “Ghi đơn” cạnh bình luận) — phần mềm không tự đoán đơn từ bình luận hay quà. Ghi đơn thì chủ quán cảm ơn khách trên LIVE.
- Các câu của chủ quán sửa được, dùng `{ten}`, `{qua}`, `{san_pham}`.
- **Đặt bảng vàng ở đâu cũng được:** xem *Bố cục màn hình LIVE* bên dưới.

## Hình LIVE nét trên điện thoại

Hình trên điện thoại chỉ nét khi nguồn game đủ **1080 × 1920 điểm ảnh** — cửa sổ nhỏ hơn thì phần mềm LIVE phải phóng to nên mờ.

1. Cửa sổ Chibi Live Game: chuột phải → **Nét nhất cho LIVE (1080 × 1920)** (Ctrl+L). Cửa sổ có thể cao hơn màn hình; phần ngoài màn hình vẫn được phát. Chất lượng Tự động bắt đầu từ *Nét nhất* (vẽ gấp đôi rồi thu nhỏ), chỉ giảm khi máy chậm.
2. Hoặc dùng nguồn **Link** (TikTok LIVE Studio) / **Browser Source** (OBS): `http://127.0.0.1:8686/game/live?quality=ultra`, rộng 1080, cao 1920 — không phụ thuộc cỡ màn hình. Trong TikTok LIVE Studio phải bật **Độ phân giải tùy chỉnh** (Custom resolution) rồi nhập 1080 × 1920; không bật thì nguồn Link chạy khung ngang, game nằm giữa hai viền tối và không vừa khung dọc. Chỉ mở một màn hình game chính.
3. Trong phần mềm LIVE: khung hình 1080 × 1920, nguồn game phủ vừa khít khung (không phóng to), bitrate cao nhất mạng tải lên cho phép.
4. Điện thoại người xem hẹp hơn 9:16 nên TikTok cắt mất khoảng 10% mỗi bên hình: các ô trên màn hình LIVE tự nằm trong phần giữa; khung *Kéo thả các ô* hiện dải sọc đỏ chỗ bị cắt.
5. Kiểm tra: Game 3D & OBS → *Hiệu năng màn hình game* ghi cỡ cửa sổ game, báo nếu chưa đủ 1080 × 1920 và báo nếu khung nguồn rộng hơn 9:16 (kèm cách sửa).

## Từ cấm & dạy chủ quán trả lời

- Trang **Người trực**, dưới mỗi bình luận:
  - **Dạy chủ quán trả lời** — gõ câu trả lời; lần sau bình luận tương tự được chủ quán tự trả lời.
  - **Cấm từ…** — bấm chọn từ nhạy cảm trong bình luận → **Thêm vào từ cấm**.
- Bình luận có từ cấm (có dấu hay không dấu) không được đọc, không được trả lời. Chủ quán nhắc nhở nhẹ nhàng (hoặc im lặng, tuỳ bạn). Người dùng từ cấm tới lần thứ 3 trong buổi thì tạm không đọc bình luận của họ tới hết buổi.
- Quản lý ở **Hội thoại & câu đã học → Từ cấm & nhắc nhở**.

## Bố cục màn hình LIVE

Game 3D & OBS → Không gian cửa hàng → *Bố cục màn hình LIVE*: mỗi ô trên màn hình LIVE (màn hình LED sản phẩm, nhãn DEMO & cảnh báo, bảng vàng, ô Sân khấu, bảng Sắp diễn ra, bảng mini-game, dòng chữ đang đọc, thẻ sản phẩm, bong bóng lời chủ quán) có công tắc **Hiện**. Bấm **Kéo thả các ô trên màn hình LIVE** để dời từng ô và kéo chấm tròn ở góc để đổi cỡ; thả tay là lưu, màn hình OBS đổi ngay. Nhãn DEMO luôn hiện khi chạy Demo. Màn hình LED (gắn trên tường quán) và bong bóng chủ quán chỉ bật/tắt.

## Khách quen

Máy chủ nhớ người xem qua các buổi LIVE. Ai quay lại được chủ quán chào đích danh (“A, Lan quay lại rồi! Buổi LIVE thứ 3 liên tiếp đó…”); khách đã tới từ 3 buổi có **♥** sau tên. Nếu máy chủ khởi động lại giữa LIVE (phiên mới trong vòng 20 phút), số phút xem và cấp Chibi được giữ nguyên. Thẻ **Khách quen** ở trang Người trực; API `GET /api/v1/regulars`.

## Mini-game

Mỗi 15–20 phút (ngẫu nhiên) LIVE tự chạy một mini-game khoảng 1 phút: **Đoán giá** (bình luận con số, gần đúng nhất thắng), **Đố vui** (bình luận A/B/C, 3 người đúng nhanh nhất thắng), **Nhanh tay** (3 người gõ đúng chữ đầu tiên thắng). Người thắng được đeo huy chương trên Chibi và lên Bảng vàng (tab Mini-game). Người trực bắt đầu/dừng ở thẻ **Mini-game** (trang Người trực); cài đặt và câu đố của shop ở Không gian cửa hàng → *Mini-game*.

## Bảng “Sắp diễn ra”

Bảng nhỏ trên màn hình LIVE cho người xem biết sắp có gì, kèm đếm ngược: bài thơ tiếp theo của chủ quán, ai sắp lên cấp, và **lịch LIVE của shop** (Không gian cửa hàng → *Bảng “Sắp diễn ra”* → “+ Thêm mục vào lịch”, ví dụ 22:10 Mini-game đoán giá; hiện khi còn dưới 90 phút, giờ Việt Nam). Kéo thả được như Bảng vàng.

## Chibi lên cấp theo thời gian xem

Người xem ở lại càng lâu, Chibi càng “xịn”: **5 phút nón lá → 15 phút áo choàng → 30 phút vương miện** (chỉnh ở Không gian cửa hàng → *Chibi lên cấp*). Cạnh tên có số cấp, sắp lên cấp thì hiện vạch tiến độ; lên cấp thì Chibi cổ vũ và chủ quán chúc mừng; khoảng 1 phút trước, chủ quán nhắc người đó ở lại. Người xem im lặng vẫn được tính thêm 10 phút sau lần thả tim / bình luận gần nhất (TikTok không báo khi ai rời LIVE). Thẻ **Ở lại lâu nhất** ở trang Người trực; nút **Thử (Demo)** để xem trước phụ kiện.

## Sân khấu nhảy & chủ quán trò chuyện

- **Sân khấu** (giữa quán — hoặc góc trước nếu chọn): người xem bình luận “nhảy” / “lên sân khấu” / “đăng ký nhảy” được xếp hàng, **ai bình luận trước lên nhảy trước**. Tới lượt, chủ quán mời lên, Chibi bước lên sân khấu nhảy một bài dưới đèn chiếu (mặc định 15 giây), camera quay sân khấu; xong thì cúi chào, bước xuống và người kế tiếp được mời. Bảng *Sân khấu* trên màn hình LIVE cho biết ai đang nhảy, ai kế tiếp và **còn bao lâu tới lượt** (“~40 giây”); 2 người kế tiếp được chủ quán gọi tên trước để khỏi rời LIVE — kéo thả tới chỗ khác và đổi cỡ được (Không gian cửa hàng → “Kéo thả bảng vàng và ô Sân khấu…”). Người trực xem/sửa hàng chờ ở thẻ **Sân khấu** (trang Người trực); cài đặt ở Game 3D & OBS → *Sân khấu*. Tắt sân khấu thì “nhảy” lại là nhảy tại chỗ như trước.
- **Chủ quán trò chuyện** (Trợ lý AI & giọng đọc → *Chủ quán trò chuyện*, cần bật “Phát trên LIVE”): chủ quán đọc bình luận và tự trả lời câu chào hỏi, khen, hỏi thăm (không gọi Claude); câu không tự trả lời được thì gọi Claude nếu bật. Bình luận của khách và câu chủ quán trả lời chỉ đọc bằng giọng, không hiện chữ (bật lại ở Không gian cửa hàng → “Hiện chữ bình luận của khách”).
- **Thơ mỗi 10–15 phút:** khi đang LIVE và giọng đọc bật, chủ quán tự nghĩ một bài thơ lục bát mới (Claude) tặng cả nhà sau mỗi 10–15 phút (ngẫu nhiên), chờ lúc không ai đang được đọc câu hỏi. Khi có người nhảy: đèn trong quán dịu xuống, đèn màu quét theo nhịp, sàn đổi màu, pháo giấy.
- **Làm thơ, kể chuyện:** khách bình luận “làm thơ đi” / “kể chuyện đi”, hoặc LIVE vắng một lúc, chủ quán đọc một bài thơ hay một truyện ngắn (có sẵn 8 + 8, thêm được của shop, hoặc để Claude làm thơ mới). Nút **Đọc thơ ngay** / **Kể chuyện ngay** để người trực gọi bất cứ lúc nào.

## Hành vi Chibi (V3)

Mỗi Chibi đại diện cho **một người xem thật** (khóa theo id TikTok, không theo nickname). Không có lệnh thì Chibi tự sống: xem kệ, xem giá, dạo quanh, đứng nghỉ, vẫy/gật đầu với Chibi bên cạnh, ngồi ghế dài uống trà, thỉnh thoảng nhảy hoặc tạo dáng. Không làm một việc 3 lần liền, không chen chỗ đứng, không đi xuyên kệ.

| Người xem bình luận | Chibi làm |
| --- | --- |
| Tên sản phẩm (“trà cà gai leo”) | Đi tới kệ, lấy hộp, giới thiệu, trả hộp về kệ |
| “chào”, “đi dạo”, “ngồi nghỉ”, “tạo dáng” | Làm ngay; đang bận thì xếp hàng làm sau |
| “nhảy”, “lên sân khấu” | Xếp hàng lên sân khấu (ai trước lên trước); tắt sân khấu thì nhảy tại chỗ |
| “làm thơ đi”, “kể chuyện đi” | Chủ quán đọc thơ / kể chuyện tặng khách |
| “về thôi”, “tạm biệt” | Vẫy tay ra về; bình luận lại thì quay lại |
| “thành phần có gì?” khi đang cầm hộp | Chỉ vào hộp, trợ lý trả lời đúng sản phẩm đó |
| “trà” (mơ hồ) | Gãi đầu “?”, không lấy bừa |
| Thả tim, chia sẻ | Biểu cảm nhỏ, tối đa 1 lần / 8 giây |

**Chỉnh trong dashboard** (Game 3D & OBS → Không gian cửa hàng → *Hành vi Chibi*): bật/tắt tự sinh hoạt, tỉ lệ từng nhóm hoạt động, số Chibi tối đa trên màn hình. Khi giọng đọc đang nói, Chibi bớt trò vui nhưng vẫn đi lại; hành vi Chibi không phát âm thanh.

**Hiệu năng:** thẻ *Hiệu năng màn hình game* hiện FPS, CPU, lệnh vẽ GPU, bộ nhớ; nút *Đo thử với 30 / 50 Chibi* (khi chạy Demo) đo ngay trên PC phát LIVE. Chibi ở xa tự giảm chi tiết khi quán đông. Xem `docs/benchmark-chibi.md`.

Chỉ bình luận ngắn (≤ 5 từ) mới là lệnh; câu dài vẫn hiện và được trợ lý đọc nhưng không điều khiển Chibi. Quà tặng không cho lợi thế mua hàng; đơn hàng không bao giờ được đoán từ bình luận. Mở `/game/live?overlay=1` để xem trạng thái từng Chibi.

## Cửa sổ game 9:16 cho Windows

Game chạy trong cửa sổ phần mềm **Chibi Live Game** (thư mục `desktop/`), luôn đúng tỉ lệ 9:16, cỡ tới 1080 × 1920, toàn màn hình hoặc ẩn viền để OBS *Window Capture*. Tải bộ cài từ GitHub Actions → *desktop-windows*, hoặc `scripts\dev_windows.ps1 -GameApp`. Chi tiết: `docs/desktop-app.md`.

## LIVE đông người xem

Máy chủ xử lý được khoảng 1 000 sự kiện mỗi giây trên máy kiểm thử (bình luận, tim, lượt vào, quà) mà không trễ; bình luận, quà và lệnh không bao giờ bị bỏ, việc phụ (trò chuyện tự động) tạm dừng khi máy chủ bận. Mỗi màn hình có hàng chờ riêng nên một máy chậm không làm chậm máy khác. Tự thử: Game 3D & OBS → *Hiệu năng màn hình game* → **Giả lập 500 sự kiện/giây** (khi chạy Demo). Chi tiết và số đo: `docs/high-load.md`.

## Trợ lý AI & giọng đọc (Claude + Vbee)

Dashboard → **Trợ lý AI & giọng đọc**:

1. **Claude API key** (console.anthropic.com → API Keys), model `claude-haiku-5-5` (rẻ nhất, đủ cho câu trả lời ngắn), hạn mức USD/ngày và /tháng. Bấm **Thử kết nối Claude** để xem một câu trả lời mẫu và chi phí.
2. **Thông tin chung của shop**: ship, thanh toán, đổi trả… AI chỉ được dùng thông tin ở đây và trong danh mục sản phẩm (giá đã xác nhận, công bố, lưu ý) — không bịa.
3. **Vbee**: App ID, Token (tạo ứng dụng trong trang API của vbee.vn). Bấm **📋 Chọn giọng từ Vbee** để tải danh sách giọng tài khoản được dùng (kể cả giọng bạn tự tạo, nghe mẫu được) và chọn một giọng — hoặc dán mã giọng (voiceCode) vào ô bên dưới. Mặc định `hn_female_ngochuyen_full_48k-fhg` (HN Ngọc Huyền). Chỉnh tốc độ, hạn mức ký tự/tháng, bấm **Nghe thử trên máy này**, rồi **Lưu cài đặt**.
4. **Phát giọng trên LIVE**: đánh dấu 4 mục chính sách → **Bật giọng đọc trên LIVE**. Chọn câu trả lời được đọc khi **người trực bấm “Đọc”** (mặc định) hoặc **tự động** (chỉ câu an toàn).
5. OBS: Browser Source đánh dấu **Control audio via OBS** (xem `docs/obs-setup.md`).

Khi LIVE, trang **Người trực & Demo**:

- Khách hỏi (có dấu “?”, “giá bao nhiêu”, “ship không”…) → phần mềm đọc “Bạn {tên} hỏi: …” (bỏ số điện thoại, liên kết, từ cấm) → Claude soạn câu trả lời → bấm **🔊 Đọc**, **✏️ Sửa rồi đọc** hoặc **Bỏ qua**. Màn hình LIVE hiện phụ đề “Câu hỏi của khách” / “🤖 Trợ lý AI”.
- **⏹ Tắt giọng ngay (F9)**: dừng tức thì, không đọc gì nữa đến khi bấm “Bật lại giọng”. **Giữ để nói (Space)** hoặc **Tự im khi micro có tiếng**: AI không nói đè người dẫn.
- **⏸ Tạm dừng AI (Ctrl+Shift+P)**: không gọi Claude, không phát giọng; game vẫn chạy.

An toàn: bình luận là dữ liệu, không phải lệnh cho AI; tên khách không gửi lên Claude; AI chỉ chọn mã sản phẩm trong danh mục; câu nói về bệnh/chữa trị, giá không có trong danh mục, hoặc AI không chắc chắn **không bao giờ tự đọc**. Hết hạn mức: game vẫn chạy, câu hỏi giá dùng câu mẫu lấy từ danh mục. Chi phí ước tính với Haiku 5.5: khoảng 0,02 cent mỗi câu hỏi.

### 🤖 Tự động hoàn toàn

Nút lớn ở đầu trang **Người trực & Demo** (cần đã đánh dấu danh sách chính sách; chưa có Vbee thì chỉ hiện phụ đề). Khi BẬT, phần mềm tự đọc bình luận và trả lời, không chờ người trực:

| Bình luận | Phần mềm làm gì | Gọi Claude? |
|---|---|---|
| Câu hỏi (“giá bao nhiêu?”, “ship không?”) | Đọc câu hỏi → đọc câu trả lời (câu đã học / giá trong danh mục / Claude) | Chỉ khi chưa có sẵn câu trả lời |
| Gọi tên sản phẩm (“trà cà gai leo”) | “Bạn … đang xem …, giá …” (chỉ đọc giá đã xác nhận; cùng sản phẩm không nhắc lại trong 45 giây) | Không |
| Chào (“chào shop”, “hello”) | Gộp vào lời chào người xem (xem bên dưới) | Không |
| Bình luận thường (“live vui quá”) | Claude trả lời; chỉ khi câu trả lời an toàn mới đọc cả bình luận lẫn câu trả lời | Có |
| Spam, từ cấm | Không đọc | Không |

Vẫn giữ nguyên an toàn: câu nói về bệnh/chữa trị, giá lạ, câu Claude không chắc chắn → chờ người trực. LIVE đông: câu hỏi luôn được ưu tiên; khi đã có 3 câu chờ đọc (chỉnh được) thì bỏ qua lời chào và bình luận thường; mỗi khách được chào/trả lời trò chuyện tối đa 1 lần mỗi phút. **F9** vẫn tắt giọng ngay; **Space** để nói chen.

### 👋 Chào người xem & đọc bình luận

Luôn chạy khi **Bật phát trên LIVE** đang bật (không cần bật “Tự động hoàn toàn”, không gọi Claude, 0 USD):

- **Chào mọi người vào xem.** Một người vào → “Chào Lan Anh, …”. Nhiều người vào cùng lúc → gom tên lại để không bỏ sót ai: “Chào Lan, Minh, Hoa, Tú, Vy và Bảo! Cảm ơn các bạn đã vào LIVE của shop ạ!” (tối đa 6 tên một câu, chỉnh được 1–15). Người đông đến mức đọc không kịp thì số tên mỗi câu tự tăng, ai chờ quá 60 giây được gộp vào “… và 18 bạn khác” để lời chào không bị trễ. Mỗi người chỉ được chào một lần trong 10 phút.
- **Đọc bình luận.** Mọi bình luận (trừ spam/từ cấm) được đọc: “Bạn Vy nói: …”. Câu hỏi luôn được ưu tiên; khi hàng chờ đọc quá dài, bình luận thường cũ được bỏ qua; mỗi khách tối đa 1 bình luận mỗi 8 giây, cùng nội dung không đọc lại.
- **Không có tiếng vẫn có chữ.** Nếu Vbee chưa nhập, hết ký tự hoặc đang lỗi, câu vẫn hiện thành **phụ đề** trên trang game (OBS) và phần mềm thử lại Vbee sau 60 giây; lỗi được ghi trong **Nhật ký lỗi**.
- Bật/tắt và câu chào nhiều người trong thẻ **👋 Chào người xem & đọc bình luận** (trang Trợ lý AI & giọng đọc).

### 🩺 Không thấy chào / không đọc bình luận?

Trang **Người trực & Demo** có thẻ **🩺 Chào người vào & đọc bình luận — kiểm tra**:

- Danh sách điều kiện, mỗi dòng ✅/❌ kèm cách sửa: *Bật phát trên LIVE* (đánh dấu 4 ô chính sách rồi bật, ở trang Trợ lý AI & giọng đọc), AI không tạm dừng, giọng không bị tắt khẩn cấp (F9), **trang game (OBS) đang mở** (lời chào/bình luận chỉ được đọc trên trang này), trang game được phép phát tiếng, chào người vào / đọc bình luận đang bật, và **âm thanh** (Vbee, giọng có sẵn của máy, hay chỉ phụ đề).
- Nhật ký từng người vào và từng bình luận: đã xếp hàng đọc hay chưa, và vì sao (ví dụ “Phát trên LIVE đang tắt”, “đã chào trong 10 phút qua”, “có từ cấm”, “hàng chờ quá đông”).
- Nút **📣 Đọc thử một câu trên trang LIVE**: đi đúng đường của lời chào, cho biết đọc bằng Vbee, giọng máy hay chỉ phụ đề.

**Không có Vbee vẫn có tiếng:** trang game đọc bằng giọng tiếng Việt có sẵn của máy phát LIVE (miễn phí). Trên Windows: *Cài đặt → Thời gian & ngôn ngữ → Giọng nói → Thêm giọng nói → Tiếng Việt*, rồi mở lại OBS. Chọn giọng và tốc độ trong thẻ 👋 ở trang Trợ lý AI & giọng đọc. Máy không có giọng tiếng Việt thì chỉ hiện phụ đề.

### Hội thoại & câu đã học

- Mọi câu hỏi trong LIVE được lưu: lúc nào, khách nào, câu hỏi (đã bỏ số điện thoại/liên kết), gợi ý, câu trả lời cuối, ai trả lời (Claude / người trực / câu đã học / câu mẫu), đã đọc chưa, chi phí. Xem và tải CSV (mở bằng Excel) ở **Hội thoại & câu đã học → Lịch sử hội thoại LIVE**. Tên khách tự xóa sau `CHIBI_EVENT_RETENTION_DAYS` ngày (mặc định 7), câu hỏi/câu trả lời giữ lại để học.
- **Học từ LIVE**: mỗi câu trả lời người trực bấm “Đọc” được nhớ cùng cách hỏi. Lần sau khách hỏi câu giống (hiểu viết tắt bn, ko, sp, ntn, sốp…; bỏ “shop ơi”, “ạ”, “nha”…; độ giống mặc định ≥ 75 %) → **tự trả lời ngay, không gọi Claude**. Câu hỏi giá cũng tự trả lời bằng giá đã xác nhận trong danh mục.
- Giá trong câu đã học được lưu dạng ‹giá hiện tại›: đổi giá sản phẩm thì câu trả lời đổi theo; giá mới chưa xác nhận thì câu đó tạm không dùng. Câu nói về tồn kho không được học; câu có “khuyến mãi”, “hôm nay”, “còn hàng”… và câu Claude tự đọc (chế độ tự động) chỉ ở dạng **chờ duyệt** cho đến khi bạn bấm Duyệt.
- Trong trang câu đã học: sửa câu trả lời, thêm cách hỏi khác, tắt/xóa, tự thêm câu trả lời mẫu, ô **Thử một câu hỏi** để xem LIVE sẽ tự trả lời gì. Từ lịch sử, bấm **Lưu thành câu đã học** cho câu nào muốn dạy lại.

`CHIBI_TTS_LOCKED=1` khóa giọng đọc bất kể dashboard. `CHIBI_FAKE_AI=1` dùng Claude/giọng giả (tiếng bíp) để demo và kiểm thử không tốn tiền.

## Nhật ký lỗi

Dashboard → **Nhật ký lỗi** (có số đỏ trên menu khi có lỗi mới) hiện mọi lỗi và cảnh báo khi phần mềm chạy, ngay lúc xảy ra:

- Máy chủ: Claude, giọng đọc Vbee, mất kết nối TikTok, cơ sở dữ liệu, lỗi bất ngờ trong API (trả về “xem Nhật ký lỗi (mã #…)”), lỗi tác vụ nền.
- Trang game (OBS) và dashboard: lỗi JavaScript, lỗi hiển thị, mất WebGL.

Lỗi giống nhau lặp lại trong 2 phút gộp thành một dòng “×N”. Bấm một dòng để xem chi tiết (khu vực, trang, chi tiết kỹ thuật) và **Chép để gửi hỗ trợ**; **Tải toàn bộ nhật ký (.txt)** để gửi cả file. API key, token, mật khẩu được che trước khi ghi. Nhật ký lưu ở `data/logs/errors.jsonl` (xoay vòng, tối đa khoảng 12 MB), còn nguyên sau khi khởi động lại.

## Kết nối TikTok LIVE

Dashboard → **Kết nối TikTok** → gõ tên tài khoản (vd. `@shoptra`) hoặc dán link LIVE (cả link `vm.tiktok.com`) → đánh dấu danh sách chính sách → **Kết nối**. Tài khoản đã kết nối được nhớ (tối đa 10, mới dùng nhất lên đầu): lần sau ô đã điền sẵn tài khoản gần nhất, các tài khoản khác bấm một lần là chọn, nút × để quên. Trước khi dùng cho buổi bán hàng, làm bài thử 9 bước trong [`docs/provider-limitations.md`](docs/provider-limitations.md) — trong đó có tóm tắt giấy phép TikTokLive (dùng cho cửa hàng của bạn được; **không** đem làm dịch vụ SaaS cho người khác) và việc tên tài khoản LIVE được gửi tới máy chủ ký Euler Stream.

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
