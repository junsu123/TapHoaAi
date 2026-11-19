# Cửa sổ game 9:16 cho Windows — Chibi Live Game

Game hiện trong **một cửa sổ phần mềm riêng** (không phải tab trình duyệt), luôn giữ đúng tỉ lệ **9:16**.
Cửa sổ này là màn hình game chính: nó nhận lệnh Chibi, đọc giọng AI và xác nhận khi Chibi làm xong.

## Cài đặt

**Cách 1 — bản cài sẵn (khuyên dùng):** trên GitHub, mở *Actions → desktop-windows → lần chạy mới nhất →
Artifacts → ChibiLiveGame-windows*. Trong đó có:
- `ChibiLiveGame-Setup-….exe` — bộ cài (tạo biểu tượng trên màn hình nền);
- `ChibiLiveGame-Portable-….exe` — chạy thẳng, không cần cài.

Windows có thể hỏi “Windows protected your PC” vì phần mềm chưa ký số: bấm *More info → Run anyway*.

**Cách 2 — chạy cùng máy chủ:** `scripts\dev_windows.ps1 -GameApp` — mở máy chủ và cửa sổ game cùng lúc
(cần Node.js; lần đầu tải Electron ~100 MB).

**Cách 3 — từ mã nguồn:** `cd desktop`, `npm install`, `npm start`.

## Dùng

- Mở phần mềm Chibi Live Shop (máy chủ) trước, hoặc để cửa sổ game **tự mở máy chủ** (Cài đặt → *Thư mục phần mềm*).
  Khi chưa có máy chủ, cửa sổ hiện màn hình chờ và tự kết nối khi máy chủ chạy.
- **Chuột phải** trong cửa sổ để mở menu. Phím tắt:

| Phím | Việc |
| --- | --- |
| `Ctrl` + `0` | Vừa màn hình (to nhất mà vẫn thấy cả khung) |
| `Ctrl` + `1` / `2` / `3` | 540 × 960 / 720 × 1280 / **1080 × 1920** điểm ảnh (đúng khung LIVE) |
| `F11` | Toàn màn hình (màn hình dọc, hoặc màn hình phụ) |
| `Ctrl` + `T` | Luôn nằm trên cùng |
| `Ctrl` + `B` | Ẩn viền cửa sổ — hình sạch cho OBS |
| `Ctrl` + `M` | Chuyển sang màn hình khác |
| `F5` | Tải lại game |
| `Ctrl` + `D` | Mở bảng điều khiển trong trình duyệt |
| `Ctrl` + `,` | Cài đặt (địa chỉ máy chủ, mã game, chất lượng, kích thước) |

- Kéo góc cửa sổ để đổi cỡ: cửa sổ luôn giữ 9:16. Cửa sổ không phóng to (maximize) được; kéo vào cạnh màn hình (snap) hay Windows thu cửa sổ lại thì phần trong tự về đúng 9:16 — phần mềm LIVE không bao giờ nhận hình bè ngang. Riêng *Toàn màn hình* (F11) trên màn hình đặt ngang vẫn là khung ngang: đừng dùng khi phát LIVE. Tiêu đề cửa sổ ghi kích thước thật (ví dụ *1080 × 1920*).
- Vị trí, kích thước và cài đặt được nhớ cho lần sau. Chỉ mở được **một** cửa sổ game.
- Game vẫn chạy đủ nhanh khi cửa sổ bị che, thu nhỏ hay nằm sau OBS; màn hình không tự tắt khi đang mở.
- Giọng đọc AI phát ngay, không cần bấm cho phép âm thanh.

## Đưa vào OBS

1. OBS → Sources → **+ Window Capture** → chọn *[Chibi Live Game.exe]: Chibi Live Game — …*.
2. *Capture Method*: **Windows 10 (1903 and up)**. Bỏ chọn *Capture Cursor*.
3. Bấm `Ctrl` + `B` trong cửa sổ game để bỏ viền (hoặc dùng *Crop* của OBS).
4. Âm thanh giọng đọc: **+ Application Audio Capture** → chọn *Chibi Live Game* (Windows 10 2004 trở lên),
   hoặc để OBS lấy âm thanh máy (Desktop Audio).
5. Kích thước: `Ctrl` + `3` cho 1080 × 1920 điểm ảnh. Trên màn hình ngang Full HD (cao 1080), cửa sổ 1080 × 1920
   cao hơn màn hình — vẫn được, OBS chụp cả cửa sổ; hoặc dùng `Ctrl` + `2` (720 × 1280) rồi để OBS phóng to.

Dùng **hoặc** cửa sổ game này **hoặc** nguồn Browser trong OBS, không dùng cả hai cùng lúc (chỉ một màn hình
game chính được nhận lệnh Chibi).

## Máy chủ ở máy khác

Cài đặt → *Địa chỉ máy chủ* `http://<IP máy chủ>:8686` và *Mã game* (trang Game 3D & OBS của bảng điều khiển).
Máy chủ phải chạy với `--host 0.0.0.0`.
