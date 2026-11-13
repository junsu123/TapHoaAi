# Changelog

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
