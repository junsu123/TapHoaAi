# Changelog

## 0.9.2 — 2026-11-14

- Sửa lỗi “Vbee lỗi 400 khi lấy danh sách giọng”: tài liệu Vbee ghi tham số kiểu `language_code` nhưng ví dụ chính thức dùng `languageCode`/`voiceOwnership`. Phần mềm thử dạng của ví dụ trước, rồi các dạng khác, giữ dạng Vbee chấp nhận; không gửi `limit` nữa. Lỗi hiện kèm lời nhắn gốc của Vbee.

## 0.9.1 — 2026-11-14 — Chọn giọng Vbee

- Sửa lỗi không đổi được mã giọng Vbee: mã giọng trước đây bị giới hạn ở chữ không dấu, số, `_ - .` nên mã giọng tự tạo/cộng đồng bị từ chối với thông báo tiếng Anh khó hiểu. Giờ nhận mọi mã không có khoảng trắng/dấu nháy, báo lỗi bằng tiếng Việt.
- Nút **📋 Chọn giọng từ Vbee**: lấy danh sách giọng qua API “Get list voices” của Vbee (`GET https://vbee.vn/api/public/v1/voices`, phân trang), nhóm “Giọng của tôi” / “Giọng Vbee & cộng đồng”, nghe mẫu, hiện hệ số ký tự.

## 0.9.0 — 2026-11-14 — Tự động hoàn toàn

- Nút **🤖 Tự động hoàn toàn** trên trang Người trực: tự đọc bình luận và trả lời không chờ người trực — câu hỏi (câu trả lời an toàn đọc ngay), gọi tên sản phẩm (“Bạn … đang xem …, giá …”), lời chào (câu mẫu), bình luận thường (Claude, chỉ đọc khi có câu trả lời an toàn).
- Hàng đợi giọng có ưu tiên (câu trả lời > câu hỏi > sản phẩm > lời chào), câu trả lời không bao giờ đọc trước câu hỏi của nó; LIVE đông thì bỏ lời chào/bình luận thường; giới hạn tần suất theo loại và theo khách.
- Cài đặt: bật/tắt từng loại, câu chào, câu đọc sản phẩm, câu đọc bình luận, ngưỡng hàng chờ.
- Sửa lỗi: mã sự kiện Demo lặp lại giữa các phiên → bình luận hiện trùng trên dashboard và câu hỏi mới có thể ghi đè câu cũ trong lịch sử hội thoại.
- Sửa lỗi: ô nhiều dòng (từ cấm, câu chào) không xuống dòng được khi gõ.

## 0.8.0 — 2026-11-14 — Lưu hội thoại LIVE và tự trả lời câu đã học

- Mọi câu hỏi trong LIVE được lưu theo phiên (câu hỏi, gợi ý, câu trả lời cuối, ai trả lời, đã đọc, chi phí); trang **Hội thoại & câu đã học** xem, tìm, tải CSV. Tên khách tự xóa sau số ngày lưu bình luận, nội dung giữ lại để học.
- Học từ LIVE: câu trả lời người trực xác nhận được nhớ; câu hỏi giống (chuẩn hóa tiếng Việt, viết tắt, từ đệm, bỏ tên sản phẩm) được trả lời ngay **không gọi Claude** và đọc luôn; câu hỏi giá dùng giá đã xác nhận.
- Giá trong câu đã học tự theo giá hiện tại; giá chưa xác nhận, nội dung về chữa bệnh hay giá lạ → không dùng. Tồn kho không học; khuyến mãi/“hôm nay” và câu Claude tự đọc chờ duyệt.
- Quản lý câu đã học: sửa, thêm cách hỏi, duyệt, tắt, xóa, thêm tay, thử câu hỏi; cài đặt độ giống, học, tự trả lời.
- Migration 0003 (`conversation_turns`, `knowledge_entries`, `knowledge_variants`).

## 0.7.0 — 2026-11-14 — Trợ lý AI Claude và giọng đọc Vbee (M4)

- Câu hỏi của khách được đọc to trên LIVE (“Bạn {tên} hỏi: …”, đã bỏ số điện thoại/liên kết/từ cấm), Claude soạn câu trả lời 1–2 câu chỉ từ danh mục và thông tin shop, người trực bấm **Đọc** (hoặc chế độ tự động cho câu an toàn).
- Giọng đọc Vbee qua Realtime API (`mode: sync`, ≤ 300 ký tự/lần, tự chia câu), lưu đệm âm thanh 3 ngày; trang game (OBS) phát lần lượt, báo bắt đầu/kết thúc, hiện phụ đề “Câu hỏi của khách” / “🤖 Trợ lý AI”.
- Tắt giọng ngay (F9), giữ để nói (Space), tự im khi micro có tiếng; tạm dừng AI dừng cả giọng.
- An toàn: bình luận là dữ liệu, tên khách không gửi lên Claude, product_id chỉ trong danh mục, câu nói về bệnh/chữa trị, giá lạ hoặc AI không chắc chắn luôn chờ người trực.
- Ngân sách: USD/ngày, USD/tháng, cảnh báo 70/90/100 %, cache 30 phút, gộp câu hỏi trùng trong 2 phút; ký tự giọng đọc/tháng. Hết hạn mức: câu mẫu lấy từ danh mục.
- Trang **Trợ lý AI & giọng đọc**: key Claude/Vbee (mã hóa, chỉ hiện dạng che), thử kết nối, nghe thử, checklist chính sách.
- `anthropic` (MIT) thành phụ thuộc chính; `CHIBI_FAKE_AI=1` cho demo/kiểm thử; `CHIBI_TTS_LOCKED=1` khóa giọng.

## 0.6.0 — 2026-11-14 — Lấy mặt hộp từ file in PDF

- Mục Sản phẩm: tải file in PDF (bản trải phẳng hoặc mỗi mặt một trang), phần mềm đặt sẵn khung 6 mặt đúng kích thước thật; kéo, nhích, xoay khung, khung tự hít mép nhau.
- Máy chủ cắt từng mặt ở độ nét cao (tới 1536 px, ≤ 600 dpi) bằng PDFium (`pypdfium2`, BSD-3/Apache-2.0).
- Xem trước hộp 3D xoay được trước khi lưu; thêm ảnh mặt đáy.
- File PDF không công khai, tự xóa sau 7 ngày; ảnh mặt hộp (.jpg) có trong bản sao lưu.

## 0.5.0 — 2026-11-14 — Hộp sản phẩm trông như thật

- Mỗi sản phẩm có ảnh riêng cho từng mặt hộp (trước, sau, trái, phải, nắp); mặt chưa có ảnh dùng màu nền chọn trên dashboard, không tự vẽ thêm nội dung bao bì.
- Hộp bo góc, nhận ánh sáng và đổ bóng như vật thật; kích thước nhập theo cm thật.
- Ảnh riêng cho thẻ sản phẩm trên LIVE (ví dụ ảnh 3D mockup của shop).
- Khi Chibi giới thiệu sản phẩm: camera tiến lại gần và hộp xoay nhẹ trái phải để thấy cả mặt bên.
- `scripts/unwarp_box.py`: cắt ảnh phẳng từng mặt hộp từ ảnh mockup 3D (cần `pip install -e "backend[tools]"`).
- Migration 0002 (tự chạy khi khởi động).

## 0.4.1 — 2026-11-14 — Chibi rời cửa hàng khi người xem rời LIVE

- TikTok không gửi sự kiện "rời LIVE", nên Chibi rời đi (vẫy tay rồi ra cửa) khi: không tương tác quá N phút (mặc định 5, chỉnh trên dashboard), số người xem giảm xuống dưới số Chibi, hoặc LIVE kết thúc.
- Thả tim, theo dõi, chia sẻ cũng tính là còn ở lại.
- Không rút Chibi đang lấy hàng; tương tác lại thì Chibi quay lại.

## 0.4.0 — 2026-11-14 — M3: kết nối TikTok LIVE

- Adapter TikTokLive 7.0.1 (tùy chọn `backend[tiktok]`, đã cài sẵn qua `dev_windows.ps1`): bình luận, quà, thả tim, người vào, theo dõi, chia sẻ, số người xem, kết thúc LIVE.
- Trạng thái trung thực cho từng lỗi: không LIVE, không tìm thấy, giới hạn tuổi, bị chặn, cần gói trả phí, giới hạn lượt, lỗi mạng.
- Link rút gọn `vm.tiktok.com` với kiểm tra chống SSRF.
- Bắt buộc xác nhận danh sách chính sách trước khi kết nối; khóa Euler Stream tùy chọn (mã hóa).
- Kết nối lại có thời gian chờ tăng dần, không bão khi kết nối rớt ngay.
- Tài liệu giấy phép, quyền riêng tư và bài thử LIVE thật 9 bước.

## 0.3.0 — 2026-11-13 — M2: editor kệ, GLB, sao lưu, dữ liệu tiếng Việt

- Sơ đồ cửa hàng kéo-thả: thêm/di chuyển/xoay/xóa kệ, kiểm tra lối đi, cửa, quầy và khả năng đi tới; khóa kệ đang có khách.
- Game hỗ trợ kệ xoay 90°.
- Sản phẩm có thể dùng mô hình GLB; lỗi tải tự quay về hộp ảnh.
- Sao lưu/khôi phục (dashboard + `scripts/backup_db.py`), xuất cấu hình JSON và CSV sản phẩm.
- Bộ dữ liệu 101 bình luận tiếng Việt + công cụ đo; hiểu “bn”, “còn ko”, “ntn”, “ship”, chữ viết dính.
- Nhãn tên không đè nhau; bỏ viền Chibi ở xa để nhẹ máy.

## 0.2.0 — 2026-11-13 — Nâng cấp đồ họa 3D

- Hết mờ: render đúng mật độ điểm ảnh của màn hình (không còn 1× cố định, không còn hạ xuống 0,6×).
- Hết nhạt: bỏ tone mapping làm bạc màu, giảm ánh sáng môi trường, bảng màu đậm hơn, đổ bóng mềm từ mức Medium.
- Phong cách cel-shading: shading 3 bậc, viền tối cho Chibi, kệ, quầy, hộp sản phẩm.
- Chibi dễ thương hơn: mắt to có điểm sáng, miệng cười, má hồng, tay tròn.
- Cửa hàng: sàn gỗ, giấy dán tường sọc, thảm lối đi, dây cờ, lọ trang trí có nắp, cây xanh.
- Cận cảnh sạch: ẩn Chibi khác che ống kính, ẩn nhãn tên trùng với thẻ sản phẩm; nhãn tên sắc nét gấp đôi.
- Chibi không đổ bóng thời gian thực (đã có bóng tròn dưới chân) để giảm chi phí GPU.

## 0.1.0 — 2026-11-13 — M0 + M1

### Thêm
- Backend FastAPI: đăng nhập Argon2id + CSRF, migration Alembic cho toàn bộ schema SPEC E.
- Đường ống sự kiện chung Demo/LIVE: normalizer, deduper, gift streak, bus có giới hạn.
- Nhận diện bình luận tiếng Việt (không dấu, sai chính tả nhẹ, alias, từ chung luôn mơ hồ).
- AvatarManager, GameActionQueue (cooldown, 2 lệnh chờ, preempt, đặt chỗ điểm đứng, ACK/timeout), CameraDirector.
- WebSocket `/ws/game` (snapshot + sequence, primary/viewer) và `/ws/dashboard`.
- Game 3D React Three Fiber: cửa hàng 6 kệ, Chibi thủ tục, A*, FSM, cầm đúng hộp, camera cận cảnh, thẻ sản phẩm, nhãn DEMO.
- Dashboard tiếng Việt: tổng quan, kết nối, người trực & demo, sản phẩm, bản đồ kệ, game & OBS.
- Kiểm thử: 94 pytest, 13 vitest, 6 Playwright có ảnh minh chứng; CI GitHub Actions.

### Chưa có (theo kế hoạch)
- Kết nối TikTok thật (M3), Claude AI (M4), OBS websocket (M5), đơn hàng TikTok Shop (M6).
