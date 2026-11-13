# Changelog

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
