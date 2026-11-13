# Triển khai trên Windows

## Yêu cầu
- Windows 10/11, GPU rời hoặc iGPU đời mới (benchmark FPS trước khi LIVE).
- Python 3.12+ (tick “Add to PATH”), Node.js 20+.

## Cài lần đầu
```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev_windows.ps1
```
Script tạo venv, cài thư viện, build giao diện, chạy migration + tạo cửa hàng demo, rồi mở server ở `127.0.0.1:8000`.

## Dữ liệu
- Mặc định trong thư mục `data\` của repo: `chibi.db` (SQLite), `media\` (ảnh/GLB), `secret.key` (khóa mã hóa).
- Đổi vị trí: đặt biến `CHIBI_DATA_DIR`.
- **Sao lưu `secret.key` riêng** — mất file này thì không giải mã được secret đã lưu.

## Truy cập từ máy khác
Mặc định chỉ nghe `127.0.0.1`. Nếu cần mở dashboard từ điện thoại trong mạng LAN, chạy với `--host 0.0.0.0`, đặt `CHIBI_COOKIE_SECURE=true` sau HTTPS (reverse proxy), và thêm `?token=…` (xem trang Game 3D & OBS) khi mở game từ máy khác. Tạo tài khoản quản trị đầu tiên chỉ làm được trên chính máy chạy phần mềm.
