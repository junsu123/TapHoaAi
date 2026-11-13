# IMPLEMENTATION PLAN — Chibi AI TikTok Live Shop

Theo SPEC mục N. `[x]` = có code + test trong repo; `[ ]` = chưa làm.

## M0 — Nền tảng ✅
- [x] Repo backend (FastAPI, Pydantic v2, Python 3.12) + frontend (React, TS, Vite)
- [x] SQLAlchemy 2 + Alembic, migration `0001_initial` cho 16 bảng SPEC E (+ `admin_sessions`)
- [x] Đăng nhập: Argon2id, cookie HttpOnly SameSite=Strict, CSRF header, khóa sau 5 lần sai
- [x] Tạo admin đầu tiên chỉ từ loopback (`/auth/setup`) hoặc `scripts/seed_demo.py --admin`
- [x] Event contract F1 (Pydantic) dùng chung cho Demo và LIVE
- [x] Normalizer, Deduper (LRU+TTL, fingerprint gắn nhãn `approximate`), GiftStreakTracker, EventBus có giới hạn
- [x] DemoProvider (bình luận, join, like, gift, sinh người xem giả có nhãn DEMO)
- [x] URL validator (allowlist host, không fetch) — T02
- [x] Mã hóa secret (Fernet, `data/secret.key`), che secret trong log
- [x] CI GitHub Actions: pytest, vitest, build, Playwright

## M1 — Vertical slice ✅
- [x] Catalog snapshot chỉ gồm sản phẩm `approved`
- [x] Product matcher tiếng Việt: exact → chứa cụm → fuzzy; alias chung → luôn mơ hồ (T03–T05)
- [x] Intent router: PRODUCT / QUESTION / AMBIGUOUS / GREETING / DANCE / SPAM / NONE
- [x] AvatarManager: 1 avatar/người, khóa stable ID, giới hạn 60, hàng chờ tràn
- [x] GameActionQueue: 1 lệnh chạy + 2 chờ, cooldown 5 s, preempt, reservation 3 điểm đứng TTL 15 s, ACK/timeout, idempotent
- [x] CameraDirector: ưu tiên, giữ tối thiểu 4 s
- [x] WebSocket hub: sequence + snapshot + RESYNC, primary/viewer (chỉ primary được ACK)
- [x] Game R3F: cửa hàng 6 kệ, Chibi thủ tục, A* (không xuyên kệ), FSM có timeout, pickup → hold → show → return, camera cận cảnh, thẻ sản phẩm, nhãn DEMO, safe area 9:16
- [x] Dashboard tiếng Việt: Tổng quan, Kết nối, Người trực & Demo, Sản phẩm (CRUD + ảnh + alias), Bản đồ kệ (gắn slot), Game & OBS
- [x] Playwright: T03, T05, T06/T07, T14, T18, T17 (tải) + dashboard; ảnh minh chứng

## M2 — Toàn bộ sản phẩm và kệ
- [ ] Editor kéo-thả kệ/slot/điểm đứng với kiểm tra chồng lấn (POST `/shelves`)
- [ ] Nhận GLB trong game (đã có kiểm tra upload GLB phía server), Chibi GLB skeleton chung giữ `rightHandSocket`
- [ ] Bộ dữ liệu `comments_vi.csv` + báo cáo precision/recall để tinh chỉnh ngưỡng matcher
- [ ] Nhãn tên chống đè nhau (screen-space), instancing cho 60+ avatar
- [ ] Backup/restore DB + media (SYS-03), xuất/nhập JSON cấu hình
- [ ] Benchmark FPS trên PC phát LIVE thật

## M3 — TikTok LIVE
- [ ] `TikTokLiveAdapter` dựa TikTokLive (rà soát giấy phép AGPL trước), map event → raw dict
- [ ] Giải link rút gọn `vm.tiktok.com` (≤ 3 redirect, kiểm host + IP private mỗi bước)
- [ ] Capability monitoring thật (available/unavailable/degraded) và contract test cho adapter
- [ ] Báo cáo sự kiện nào đọc được thực tế (`docs/provider-limitations.md`)

## M4 — Claude AI & người trực
- [ ] Nhập API key (mã hóa, trả về dạng che), test connection, chọn model (mặc định `claude-haiku-5-5` — kiểm tra lại giá trước khi bật)
- [ ] Claude chỉ cho QUESTION/AMBIGUOUS, JSON schema + allowlist product_id, lọc từ cấm
- [ ] BudgetGuard: USD/ngày, USD/tháng, cảnh báo 70/90/100 %, cache, gộp trùng
- [ ] Trạng thái gợi ý `AI đề xuất / Người trực đã xác nhận / Chưa được trả lời` (khung đã có trên dashboard)

## M5 — OBS & vận hành
- [ ] Cảnh mẫu `Shop LIVE`, `Game Demo`, `Break`, `Emergency`; obs-websocket tùy chọn (localhost)
- [ ] Checklist chính sách hiển thị trước khi kết nối LIVE thật
- [ ] Đo độ trễ end-to-end trên LAN thật, trình cài đặt Windows

## M6 — Đơn hàng TikTok Shop
- [ ] Chỉ bắt đầu khi có app/quyền chính thức; webhook verify + idempotency
