# Thiết lập OBS

1. Chạy phần mềm (`scripts\dev_windows.ps1`) trên **PC phát LIVE**.
2. OBS → Sources → **+ Browser** → URL `http://127.0.0.1:8686/game/live` (thay 8686 nếu bạn đổi cổng), Width **1080**, Height **1920**, FPS **30** (máy yếu: 720 × 1280).
3. Chỉ để **một** nguồn game chính. Bản xem trước trên dashboard dùng `?role=viewer` nên không tranh quyền.
4. Tùy chọn URL:
   - `?quality=low|medium|high` — bỏ trống để tự giảm chất lượng khi FPS < 24.
   - `?safeTop=0.1&safeBottom=0.2&safeRight=0.15` — vùng an toàn để thẻ sản phẩm không bị giao diện TikTok che.
5. Cảnh gợi ý:
   - **Shop LIVE**: webcam + mic người thật là chính; game đặt góc/lớp phụ.
   - **Game Demo**: game toàn màn hình — chỉ để kiểm thử.
   - **Break**, **Emergency**: ảnh tĩnh/thông báo.
6. Âm thanh: mic người thật vào OBS. Phần mềm hiện không phát âm thanh.

Không dùng điện thoại quay màn hình máy tính (gây sọc moiré). Điều khiển cảnh bằng obs-websocket là mốc M5.
