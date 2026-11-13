# Kết nối TikTok LIVE — giới hạn, giấy phép và cách thử

Trạng thái: **code xong (M3), chưa thử với buổi LIVE thật** (`Not tested`). Môi trường phát triển không truy cập được TikTok, nên adapter được kiểm thử bằng chính các lớp sự kiện và lỗi của thư viện TikTokLive 7.0.1 với kết nối giả lập. Bước "Thử LIVE thật" bên dưới phải làm trên máy của cửa hàng.

## Cách hoạt động

1. Dán link `https://www.tiktok.com/@tên/live` (hoặc link rút gọn `vm.tiktok.com/...`) → đánh dấu danh sách chính sách → **Kết nối**.
2. Link rút gọn được mở tối đa 3 lần chuyển hướng; mỗi bước phải là tên miền tiktok.com và không trỏ về địa chỉ nội bộ (chống SSRF).
3. Thư viện TikTokLive kiểm tra tài khoản có đang LIVE, xin chữ ký kết nối từ máy chủ **Euler Stream**, rồi mở WebSocket tới TikTok.
4. Chỉ khi WebSocket mở xong, trạng thái mới chuyển sang **Đã kết nối** (kèm số phòng).
5. Mất kết nối → thử lại với thời gian chờ tăng dần (1, 2, 4 … tối đa 60 giây, tối đa 10 lần). Bấm **Ngắt kết nối** dừng ngay.

## Trạng thái và ý nghĩa

| Trạng thái | Khi nào | Tự thử lại? |
| --- | --- | --- |
| Không phát LIVE | Tài khoản không đang LIVE (T01) | Không |
| Không hỗ trợ | Không tìm thấy tài khoản / chưa đủ điều kiện LIVE; LIVE giới hạn độ tuổi; TikTok chặn kết nối; máy chủ ký đòi gói trả phí; chưa cài thư viện | Không |
| Mất kết nối | Lỗi mạng, WebSocket bị đóng, máy chủ ký giới hạn lượt | Có |
| Đã kết thúc | TikTok báo buổi LIVE kết thúc | Không |

Hệ thống **không** vượt CAPTCHA, không dùng cookie/session đăng nhập, không né chặn. Khi bị chặn, lý do thật được hiển thị và người trực có thể chuyển sang Demo.

## Loại sự kiện

| Sự kiện | Dùng để | Ghi chú |
| --- | --- | --- |
| Bình luận | Điều khiển Chibi, câu hỏi cho người trực | Cần cho tính năng chính |
| Người vào | Tạo Chibi chào | Không phải ai vào cũng được TikTok gửi sự kiện |
| Quà tặng | Hiệu ứng vui, camera | Chuỗi quà chỉ cộng một lần khi kết thúc chuỗi |
| Thả tim, theo dõi, chia sẻ | Hiệu ứng nhẹ | Không tạo Chibi |
| Số người xem | Hiển thị trên dashboard | Lấy từ TikTok, không ước đoán |

Bảng "Thực tế trong phiên này" trên trang Kết nối ghi **Đã nhận được** khi loại sự kiện đó thật sự đến; **Chưa thấy sự kiện nào** không có nghĩa là TikTok không gửi — chỉ là chưa quan sát được.

## Giấy phép TikTokLive (tóm tắt, không phải tư vấn pháp lý)

- Giấy phép: **"Modified AGPL-3.0"** (AGPL-3.0 kèm điều khoản bổ sung 18–21).
- §18 cho phép tích hợp vào **game, overlay, bot TikTok LIVE** mà không buộc dự án phải theo AGPL — trường hợp phần mềm này chạy cho chính cửa hàng.
- §19: quyền đó **mất** nếu phần mềm được dùng làm nền cho dịch vụ thương mại, đóng mã hoặc SaaS cung cấp cho bên thứ ba qua mạng (ví dụ bán dịch vụ "kết nối LIVE" cho nhiều shop). Khi đó phải tuân thủ AGPL-3.0 đầy đủ (công bố mã nguồn phía server).
- Thư viện là bản **không chính thức**, có thể hỏng khi TikTok thay đổi. Phiên bản được ghim `TikTokLive==7.0.1`; nâng cấp có chủ đích và chạy lại `pytest tests/test_tiktok_adapter.py`.

Nếu định thương mại hóa phần mềm cho nhiều cửa hàng, hãy hỏi luật sư hoặc cân nhắc nhà cung cấp có hợp đồng (API chính thức hoặc dịch vụ trả phí).

## Quyền riêng tư

- Để kết nối, **tên tài khoản LIVE của cửa hàng** được gửi tới máy chủ ký `api.eulerstream.com` (bên thứ ba). Không có dữ liệu người xem nào được gửi đi.
- Khóa Euler Stream (nếu có) được mã hóa trong cơ sở dữ liệu và không bao giờ hiện lại đầy đủ.

## Chi phí

Bản miễn phí của máy chủ ký giới hạn số lần kết nối. Nếu thường gặp "giới hạn lượt", mua khóa tại eulerstream.com và nhập ở trang Kết nối — nằm trong mục "Provider TikTok LIVE trả phí nếu cần (0–25 USD)" của ngân sách (SPEC J). Kiểm tra giá hiện hành trước khi mua.

## Thử LIVE thật (bắt buộc trước khi dùng bán hàng)

Làm với một tài khoản thử, không phải buổi bán hàng thật:

1. `git pull`, chạy `scripts\dev_windows.ps1` (đã cài sẵn thư viện TikTokLive).
2. Bật LIVE trên tài khoản thử. Mở `/game/live` và dashboard.
3. Kết nối bằng link LIVE → trạng thái phải thành **Đã kết nối** và có số phòng.
4. Từ một điện thoại khác, bình luận `trà cà gai leo` → Chibi mang tên bạn đi lấy đúng hộp.
5. Bình luận `trà` → mục "Cần người trực xử lý" hiện câu hỏi, không Chibi nào đi.
6. Gửi một bông hồng liên tiếp vài lần → tổng quà tăng **đúng một lần** khi kết thúc chuỗi.
7. Tắt Wi-Fi 20 giây rồi bật lại → **Mất kết nối** rồi tự **Đã kết nối**, không có bình luận trùng.
8. Kết thúc LIVE → trạng thái **Đã kết thúc**.
9. Ghi kết quả vào bảng dưới, rồi đổi nhãn trong `docs/acceptance-report.md` từ `Not tested` sang `Verified live` kèm ngày.

| Loại sự kiện | Kết quả thực tế | Ngày thử |
| --- | --- | --- |
| Bình luận | | |
| Người vào | | |
| Quà tặng / chuỗi quà | | |
| Thả tim | | |
| Theo dõi / chia sẻ | | |
| Số người xem | | |
| Tự kết nối lại | | |
| Kết thúc LIVE | | |
