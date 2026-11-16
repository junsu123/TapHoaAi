# Đo hiệu năng Chibi (đặc tả V3 — T16)

## Cách đo trên PC phát LIVE (khuyên dùng)

1. Chạy Demo (không đo lúc LIVE thật). Mở `/game/live` trên PC phát LIVE (hoặc trong OBS).
2. Dashboard → **Game 3D & OBS** → thẻ **Hiệu năng màn hình game** → bấm **Đo thử với 30 Chibi**.
   Phần mềm thêm Chibi demo cho đủ 30, chờ 8 giây cho quán ổn định rồi đo 20 giây; kết quả ghi vào bảng.
3. Bấm **Đo thử với 50 Chibi**, rồi **Cho tất cả Chibi ra về** khi xong.
4. Đọc kết quả:
   - **FPS trung bình ≥ 30**: ổn. 24–30: tạm được. Dưới 24: trang game tự hạ chất lượng; đặt *Số Chibi tối đa trên màn hình* xuống 30–40.
   - **Khung chậm (ms)**: 5 % khung chậm nhất; dưới 50 ms là mượt.
   - **CPU Chibi (ms)**: thời gian tính hành vi mọi Chibi mỗi khung; nên dưới 2 ms.
   - **Lệnh vẽ**: tải GPU; card đồ họa rời chịu được vài nghìn.
   - Dòng chữ nhỏ dưới các ô cho biết **card đồ họa** trình duyệt đang dùng. Nếu thấy “SwiftShader” hoặc “Microsoft Basic Render” thì trình duyệt/OBS đang vẽ bằng CPU — bật tăng tốc phần cứng.

Số chính thức (bao nhiêu Chibi giữ được 30 FPS) chỉ chốt sau khi đo trên PC phát LIVE thật.

## Mức chi tiết (LOD) tự động

| Mức | Khi nào | Chibi gần (đầy đủ) | Chibi vừa | Chibi xa |
| --- | --- | --- | --- | --- |
| 0 | ≤ 20 Chibi và FPS ổn | mọi Chibi | – | – |
| 1 | 21–35 Chibi, hoặc FPS < 27 | < 9 m | 9–17 m: bỏ viền | > 17 m: khối ít đa giác, bỏ má hồng/mắt lấp lánh/miệng, cử động cập nhật cách khung |
| 2 | > 35 Chibi, hoặc FPS < 22 | < 6 m | 6–13 m | > 13 m |

Không bao giờ giảm: Chibi đang được camera quay, Chibi đang cầm hộp sản phẩm, tên khách. Chibi ngoài khung hình không tính cử động.
So sánh khi cần: `/game/live?lod=0` vẽ mọi Chibi đầy đủ.

## Kết quả trên máy kiểm thử (không phải PC phát LIVE)

Máy kiểm thử **không có card đồ họa**: Chrome vẽ bằng CPU (SwiftShader), nên FPS tuyệt đối rất thấp và **không** đại diện cho PC thật. Các số dưới đây chỉ dùng để so sánh tương đối.

Đo ngày 16/11/2026, khung 540 × 960, 50 Chibi, chất lượng *vừa* cố định, 2 lần mỗi chế độ (trung bình 3 lần đọc cuối):

| Chế độ | FPS | Khung chậm 5 % | Lệnh vẽ | Tam giác | Bộ nhớ JS |
| --- | --- | --- | --- | --- | --- |
| LOD bật (mặc định) | 2,7 – 3,1 | 390 – 530 ms | ~1 300 | ~124 000 | 29 – 37 MB |
| Mọi Chibi đầy đủ (`?lod=0`) | 1,1 | 1 100 – 1 350 ms | ~1 930 | ~765 000 | 29 – 31 MB |

LOD giảm khoảng 6 lần số tam giác và 1/3 số lệnh vẽ; trên máy vẽ bằng CPU, FPS tăng khoảng 2,5 lần.

Nút *Đo thử* trong dashboard (chất lượng tự động, đã tự hạ xuống *thấp*):

| Chibi | FPS TB | FPS thấp nhất | Khung chậm | CPU Chibi | Lệnh vẽ | Bộ nhớ |
| --- | --- | --- | --- | --- | --- | --- |
| 32 | 3,0 | 2,3 | 877 ms | 1,41 ms | 806 | 48 MB |
| 50 | 3,6 | 3,5 | 516 ms | 0,86 ms | 1 032 | 29 MB |

CPU cho hành vi của 50 Chibi chỉ ~1 ms/khung: phần nặng là vẽ hình, không phải tính hành vi.
