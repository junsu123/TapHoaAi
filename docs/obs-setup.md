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
6. Âm thanh:
   - Mic người thật vào OBS như bình thường.
   - Nếu bật **giọng đọc AI** (Dashboard → Trợ lý AI & giọng đọc): trong thuộc tính Browser Source, đánh dấu **Control audio via OBS** (“Điều khiển âm thanh qua OBS”). Tiếng đọc câu hỏi/câu trả lời sẽ thành một kênh riêng trong Audio Mixer — chỉnh to nhỏ, hoặc thêm bộ lọc **Compressor/Ducking** để tự nhỏ đi khi mic có tiếng.
   - Chỉ nguồn game **chính** (không có `?role=viewer`) phát tiếng; bản xem trước trên dashboard chỉ hiện phụ đề.
   - OBS tự cho phép phát tiếng. Nếu mở trang game bằng Chrome thường, bấm nút “🔈 Bấm để bật âm thanh” một lần.

Không dùng điện thoại quay màn hình máy tính (gây sọc moiré). Điều khiển cảnh bằng obs-websocket là mốc M5.
