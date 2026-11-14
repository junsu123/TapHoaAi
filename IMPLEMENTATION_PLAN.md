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

## M2 — Toàn bộ sản phẩm và kệ (phần lớn xong)
- [x] Nâng cấp đồ họa: render đúng độ phân giải, cel-shading, viền, cửa hàng chi tiết hơn
- [x] Editor kéo-thả kệ (thêm/di chuyển/xoay 90°/xóa) với kiểm tra: trong cửa hàng, lối đi ≥ 0,9 m, không chắn cửa/quầy, khách đi tới được mọi điểm đứng; từ chối khi kệ đang có khách lấy hàng
- [x] Game hỗ trợ kệ xoay (đường đi, hướng nhìn, giơ hộp ra phía ngoài kệ)
- [x] Sản phẩm dùng mô hình GLB (giữ tỷ lệ, cầm trên tay), lỗi tải → tự dùng hộp ảnh
- [x] Bộ dữ liệu `tests/fixtures/comments_vi.csv` (101 bình luận) + `python -m app.eval_matcher`; hiểu teencode hỏi giá/tồn kho, chữ viết dính
- [x] Nhãn tên không đè nhau (bố trí theo màn hình), bỏ viền Chibi ở xa (giảm draw call)
- [x] Sao lưu/khôi phục DB + media (zip có manifest, kiểm tra an toàn), xuất JSON cấu hình và CSV sản phẩm
- [ ] Chibi dùng GLB có xương + hoạt ảnh (cần chọn bộ mô hình có giấy phép rõ ràng)
- [ ] Instancing cho 60+ avatar nếu benchmark trên PC thật cho thấy cần
- [ ] Benchmark FPS trên PC phát LIVE thật
- [ ] Bổ sung bình luận thật (đã ẩn danh) vào bộ dữ liệu; nhập cấu hình JSON

## M3 — TikTok LIVE (code xong, chờ thử LIVE thật)
- [x] Rà soát giấy phép TikTokLive 7.0.1 ("Modified AGPL-3.0": dùng cho game/overlay của shop được, SaaS thì không) — ghim phiên bản
- [x] `TikTokLiveAdapter`: map bình luận/quà/thả tim/vào/theo dõi/chia sẻ/số người xem → raw dict; kết thúc LIVE → `Đã kết thúc`
- [x] Lỗi thật thành trạng thái thật: không LIVE, không tìm thấy, giới hạn độ tuổi, bị chặn, cần gói trả phí, giới hạn lượt, lỗi mạng
- [x] Giải link rút gọn `vm.tiktok.com` (≤ 3 chuyển hướng, kiểm host + IP nội bộ mỗi bước)
- [x] Theo dõi loại sự kiện thực tế nhận được trong phiên; chống bão kết nối lại
- [x] Bắt buộc xác nhận danh sách chính sách trước khi kết nối; khóa Euler Stream tùy chọn (mã hóa)
- [x] Contract test với lớp sự kiện/lỗi thật của TikTokLive; luồng end-to-end bình luận LIVE → Chibi
- [ ] **Thử với buổi LIVE thật** và ghi kết quả từng loại sự kiện (`docs/provider-limitations.md`)

## M4 — Claude AI & người trực
- [x] Nhập API key (mã hóa, trả về dạng che), test connection, chọn model (mặc định `claude-haiku-5-5`, 0,10/0,50 USD mỗi triệu token — giá tra lại 2026-11)
- [x] Claude chỉ cho QUESTION/AMBIGUOUS, JSON schema (structured outputs) + allowlist product_id, lọc từ cấm, chặn lời hứa sức khỏe và giá ngoài danh mục
- [x] BudgetGuard: USD/ngày, USD/tháng, cảnh báo 70/90/100 %, cache, gộp trùng; hết hạn mức → câu mẫu từ danh mục
- [x] Trạng thái gợi ý `AI đề xuất / Cần người trực xem / Người trực đã xác nhận / Đã đọc tự động / Chưa được trả lời`
- [x] AI-06 giọng đọc Vbee (sync API): đọc câu hỏi + câu trả lời, tắt mặc định, checklist chính sách, kill switch F9, giữ để nói / tự im theo micro, phụ đề “Trợ lý AI”, hạn mức ký tự
- [ ] **Thử với Claude API key và tài khoản Vbee thật** (sandbox không gọi được api.anthropic.com/api.vbee.vn)

## M5 — OBS & vận hành
- [ ] Cảnh mẫu `Shop LIVE`, `Game Demo`, `Break`, `Emergency`; obs-websocket tùy chọn (localhost)
- [ ] Checklist chính sách hiển thị trước khi kết nối LIVE thật
- [ ] Đo độ trễ end-to-end trên LAN thật, trình cài đặt Windows

## M6 — Đơn hàng TikTok Shop
- [ ] Chỉ bắt đầu khi có app/quyền chính thức; webhook verify + idempotency
