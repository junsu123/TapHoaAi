# LIVE đông người xem: ổn định, không đơ, không quá tải

## Đã làm gì

| Vấn đề khi đông | Cách xử lý |
| --- | --- |
| Mỗi sự kiện (bình luận, lượt vào, quà…) ghi vào cơ sở dữ liệu ngay, một lần ghi đĩa mỗi sự kiện — từ khoảng 500 sự kiện/giây máy chủ không theo kịp | Ghi **theo lô** vài lần mỗi giây trong một luồng riêng; thả tim và số người xem chỉ đếm, không ghi từng cái |
| Một máy xem dashboard chậm (Wi-Fi yếu, tab bị treo) làm dồn tin nhắn, bộ nhớ tăng mãi | Mỗi màn hình có **hàng chờ riêng có giới hạn**; màn hình quá chậm được ngắt và tự kết nối lại, nhận lại toàn bộ trạng thái — không làm chậm màn hình khác |
| Hàng trăm tin nhắn nhỏ mỗi giây tới trang game và dashboard | **Gộp tin nhắn** thành khung: trang game nhận ≤ ~30 khung/giây (trễ thêm ~30 ms), dashboard 10 khung/giây |
| Chibi vào/ra liên tục khi quán đầy (40–50 lượt/giây) | Chibi vào **đều đặn ~3/giây**, ở lại ít nhất 40 giây; người chỉ vào xem (chưa bình luận) không chen khi quán đầy |
| Người hỏi mua bị kẹt sau hàng trăm người đang trò chuyện | **Hàng ưu tiên**: người gọi tên sản phẩm, rồi người tặng quà, được vào trước (ai hỏi trước vào trước); có thể thế chỗ Chibi đã ở ≥ 15 giây; yêu cầu quá 30 giây bị bỏ (đặc tả §4) |
| Mỗi món quà: chủ quán mời trà + bảng vàng gửi lại toàn bộ | Mời trà tối đa 1 khách / 15 giây (mỗi khách 1 lần / 3 phút), những người còn lại được **cảm ơn chung** trong một bong bóng; bảng vàng cập nhật tối đa 1 lần/giây |
| Dashboard nhận 300+ bình luận/giây, giao diện giật | Lệnh, câu hỏi, tên sản phẩm **luôn hiện**; bình luận trò chuyện thường tối đa 12/giây (phần còn lại được đếm và báo “LIVE rất đông: N bình luận…”); danh sách chỉ vẽ lại dòng mới |
| Trợ lý AI: mỗi câu hỏi mở một lượt gọi Claude, dồn hàng phút | Tối đa 12 câu đang soạn; vượt quá thì để người trực trả lời. Trò chuyện tự động: một câu một lúc, và tạm tắt khi máy chủ bận |
| Bộ nhớ tăng theo thời gian LIVE | Mọi bộ nhớ đệm đều có giới hạn; người xem đã rời > 10 phút được quên (quay lại vẫn đúng Chibi cũ), lệnh đã xong được dọn |
| Không biết máy chủ có đang quá tải | **Đo liên tục**: sự kiện/giây, độ trễ xử lý, độ trễ vòng lặp, CPU, RAM; ba mức *Ổn định / Bận / Quá tải*. Khi bận, việc phụ (trò chuyện tự động) dừng trước; bình luận, quà, lệnh không bao giờ bị bỏ |

## Tự thử trên máy của bạn

Dashboard → **Game 3D & OBS** → thẻ *Hiệu năng màn hình game* → phần **Máy chủ khi LIVE đông**: bấm
*Giả lập 200 / 500 / 1000 sự kiện/giây* (chỉ khi chạy Demo, 30 giây, 3 000 người xem giả). Xem
tình trạng, độ trễ, CPU, RAM ngay trên thẻ; mở màn hình game để xem Chibi.

Thử nghiệm bằng dòng lệnh (tạo máy chủ riêng, không đụng dữ liệu thật):

    backend/.venv/bin/python scripts/loadtest.py --rates 100,300,600,1000 --seconds 20 --out ketqua.json

## Kết quả đo (máy kiểm thử, 16/11/2026)

Cùng một kiểu tải cho cả hai phiên bản: 3 000 người xem giả, ~45 % thả tim, 30 % bình luận (12 % gọi
tên sản phẩm, 10 % câu hỏi), 18 % lượt vào, 3 % quà; giọng đọc, chào khách, đọc bình luận và trả lời
tự động đều bật; một trang game OBS, một trang xem trước, hai dashboard (một máy giả lập chậm).
CPU tính theo một nhân (100 % = một nhân đầy).

| Sự kiện/giây | Trước: xử lý được | Trước: trễ (p95) | Trước: CPU | Trước: bỏ | Sau: xử lý được | Sau: trễ (p95) | Sau: CPU | Sau: bỏ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 100/giây | 29 ms | 23 % | 0 | 100/giây | 1 ms | 9 % | 0 |
| 300 | 301/giây | 41 ms | 60 % | 0 | 302/giây | 3 ms | 14 % | 0 |
| 600 | 508/giây (nghẽn) | 3,7 giây | 90 % | 223 | 603/giây | 6 ms | 23 % | 0 |
| 1 000 | 470/giây (nghẽn) | 6,8 giây | 92 % | 9 114 | 1 007/giây | 12 ms | 35 % | 0 |

- Dashboard trên máy chậm: trước đây bình luận tới trễ 10 → 80 giây và càng lúc càng trễ; nay ~60 ms.
- Trang game OBS: trước 128–213 khung tin/giây; nay 11–18 khung/giây.
- Chibi vào/ra khi quán đầy (100 sự kiện/giây, 20 giây): trước 978 lượt vào + 918 lượt ra; nay 114 + 54.
- Thử trên trình duyệt thật (500 sự kiện/giây trong 30 giây): một người gọi “trà cà gai leo” giữa cơn bão vẫn có Chibi đi lấy hộp sau ~8 giây; bấm chuyển trang dashboard ~1 giây; không lỗi JavaScript.

**Chạy liền 10 phút ở 400 sự kiện/giây** (~225 000 sự kiện): độ trễ xử lý luôn dưới 5 ms, CPU ổn định ~19 %, không màn hình nào mất kết nối. Bộ nhớ máy chủ 100 → 131 MB trong 3 phút đầu (các bộ đệm có giới hạn đầy dần), rồi +11 MB, +9 MB ở mỗi 3 phút sau — tăng chậm dần, kết thúc ở 152 MB. Nên theo dõi ô *bộ nhớ máy chủ* trong một buổi LIVE dài thật.

Một LIVE bán hàng rất lớn thường dưới 50 bình luận/giây; mức 1 000 sự kiện/giây ở trên là để chắc chắn có dư.

## Giới hạn còn lại

- Số đo trên là máy kiểm thử (Linux, không card đồ họa). Hãy chạy *Giả lập* trên PC phát LIVE.
- Trang game (vẽ 3D) vẫn là phần nặng nhất của máy phát LIVE — xem `docs/benchmark-chibi.md`.
- Khi rất nhiều người cùng gọi một sản phẩm, quán chỉ có chỗ cho số Chibi tối đa; người đến sau chờ tối đa 30 giây, quá thì yêu cầu được bỏ (bình luận vẫn hiện cho người trực).
- Kết nối TikTok thật (thư viện TikTokLive) chưa được thử ở mức tải này.
