# Giới hạn nguồn sự kiện TikTok LIVE

Trạng thái hiện tại: **chưa có kết nối TikTok thật** (mốc M3). Khi bấm Kết nối với một link hợp lệ, hệ thống báo `Không hỗ trợ` — không bao giờ giả `Đã kết nối`.

## Điều đã biết trước khi làm M3

- Chỉ dán link LIVE **không** cho quyền đọc đơn hàng, không bảo đảm thấy mọi khán giả và không tương đương API LIVE chính thức.
- Thư viện dự kiến (TikTokLive, Python) là **không chính thức**, có thể ngừng hoạt động khi TikTok thay đổi, và dùng giấy phép **AGPL** — cần đánh giá điều khoản trước khi phân phối thương mại.
- Hệ thống không vượt CAPTCHA, không chiếm cookie, không vượt giới hạn truy cập. Bị chặn → báo lỗi thật, gợi ý dùng Demo.

## Cách hệ thống xử lý dữ liệu thiếu

| Thiếu | Hành vi |
| --- | --- |
| Không có `event_id` | Dùng fingerprint 2 giây, gắn `dedup_mode = approximate` |
| Không có user ID ổn định | Dùng `unique_id`; không có cả hai → không tạo Chibi |
| Không có sự kiện join | Chibi xuất hiện khi người xem bình luận hoặc tặng quà (T10) |
| Không có số người xem | Dashboard hiện “Nguồn hiện tại không cung cấp”, không ước đoán |
| Gift streak gửi lặp | Chỉ cộng khi `repeat_end = true`, một lần mỗi chuỗi (T08) |

## Việc cần làm ở M3

Ghi lại tại đây, cho từng loại sự kiện (comment, join, like, follow, gift, viewer count), kết quả **thực tế** khi thử với tài khoản thật: `available / unavailable / degraded`, kèm ngày thử.
