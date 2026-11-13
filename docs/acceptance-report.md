# Acceptance report — M0 + M1

Ngày: 13/11/2026 · Commit: xem lịch sử nhánh `m0-m1-vertical-slice`

## Kết quả chạy test

| Bộ test | Lệnh | Kết quả |
| --- | --- | --- |
| Backend (pytest) | `cd backend && .venv/bin/pytest -q` | **120 passed** |
| Frontend unit (vitest) | `cd frontend && npx vitest run` | **17 passed** |
| Trình duyệt thật (Playwright + WebGL SwiftShader) | `cd frontend && npx playwright test` | **10 passed** (gồm 4 test M2) |

Playwright đọc trạng thái **thật** của client (`window.__chibiDebug`), không mock: một test chỉ PASS khi trình duyệt đã đi, nhặt, giơ và trả đúng hộp.

## Bảng nghiệm thu SPEC L

| ID | Kết quả | Bằng chứng |
| --- | --- | --- |
| T01 | **Một phần** — kết nối TikTok thật là M3; hiện báo “Không hỗ trợ”, test xác nhận không bao giờ báo “Đã kết nối” | `test_live_connect_never_claims_success_before_provider` |
| T02 | **PASS** — URL ngoài allowlist bị từ chối, không có request mạng | `test_invalid_live_urls`, `test_live_connect_validation`, Playwright Dashboard |
| T03 | **PASS** — 1 avatar → Kệ 2 → cầm `TRA_CA_GAI_LEO` → close-up → trả hộp → COMPLETED sau khi client xác nhận | `test_t03_comment_to_completed_action`, Playwright T03; ảnh `evidence/T03-*.png` |
| T04 | **PASS** — `ca gai leo` cùng SKU | `test_ca_gai_leo_variants_match_same_sku` |
| T05 | **PASS** — `trà` không đoán, chuyển người trực | `test_generic_word_is_ambiguous_never_guessed`, Playwright T05 |
| T06 | **PASS** — không tạo avatar thứ 2, preempt, không cầm 2 hộp | `test_same_user_two_products_in_one_second`, Playwright T06/T07 |
| T07 | **PASS** — 3 điểm đứng, người thứ 4 chờ cạnh kệ rồi được phục vụ | `test_four_users_same_product_queue_at_stand_positions`; ảnh `evidence/T07-queue.png` |
| T08 | **PASS** — gift streak chỉ cộng một lần khi kết thúc chuỗi | `test_gift_streak_counted_once_at_end` |
| T09 | **Một phần** — reconnect backoff + chống trùng sau reconnect đã test với provider giả lập lỗi; chưa thử ngắt mạng với TikTok thật (M3) | `test_reconnects_after_failures_and_dedupes_replay`, `test_replayed_events_are_deduplicated` |
| T10 | **PASS** — không cần join, bình luận tạo Chibi | `test_t10_…` |
| T11 | **Chưa làm (M4)** — hiện chỉ có chế độ không-AI, game chạy bình thường | — |
| T12 | **Chưa làm (M4)** | — |
| T13 | **Một phần** — bình luận injection chỉ là dữ liệu, không chọn sản phẩm/không có quyền; phần Claude ở M4 | `test_prompt_injection_text_is_just_data` |
| T14 | **PASS** — hộp 3D dùng đúng ảnh mặt trước đã tải lên; các mặt khác màu trơn | Playwright T03+T14 (chờ ảnh `/media/…` 200); ảnh `evidence/T03-2-closeup-holding-box.png` |
| T15 | **PASS (backend)** — đổi kệ → lệnh mới đi kệ mới, game nhận `LAYOUT_UPDATED` | `test_move_product_to_new_shelf_publishes_layout` |
| T16 | **Một phần** — Pause AI không dừng game/bình luận; TTS/gợi ý AI ở M4 | `test_ai_pause_does_not_stop_game` |
| T17 | **PASS trên renderer CPU** — 60 avatar + 100 bình luận: không crash, queue ≤ 180, 0 lỗi; số liệu bên dưới | `test_load_60_avatars_100_comments`, Playwright T17; `evidence/T17-load-report.json` |
| T18 | **PASS** — reload giữa lúc đi, nhận snapshot, không nhân bản, lệnh vẫn hoàn tất | `test_t18_…`, Playwright T18; `evidence/T18-after-reload.png` |
| T19 | **PASS** — “Chưa kết nối Shop”, không có đơn giả | `test_shop_not_configured`, Playwright Dashboard |
| T20 | **Một phần** — game không phụ thuộc OBS; báo trạng thái obs-websocket là M5 | — |

## M2 — kết quả

| Hạng mục | Kết quả | Bằng chứng |
| --- | --- | --- |
| Editor kệ (GAME-02, PRD-02) | **PASS** — kéo thả, phím mũi tên, xoay; vị trí sai bị từ chối kèm lý do tiếng Việt; game nhận bản đồ mới | `test_store_layout.py` (15), Playwright “M2 shelf editor”; `evidence/M2-shelf-editor.png` |
| Kệ xoay trong game | **PASS** — 90°/180°/270°: đi tới, nhìn vào kệ, giơ hộp ra phía ngoài | vitest “rotated shelves” |
| GLB sản phẩm (GAME-06) | **PASS** — tải lên, kiểm tra, Chibi cầm đúng mô hình; lỗi → hộp ảnh | `test_product_glb_model_reaches_game_layout`, Playwright “M2 GLB”; `evidence/M2-glb-in-hand.png` |
| Sao lưu/khôi phục (SYS-03) | **PASS** — zip có manifest, chặn file lạ/đường dẫn ngược, khôi phục tạo bản an toàn trước | `test_backup.py` (9), Playwright “M2 backup” |
| Bộ dữ liệu tiếng Việt (PRD-03) | 101 bình luận: đúng ý định 100 %, đi đúng sản phẩm 60/60, **đi sai sản phẩm 0** | `test_dataset.py`, `python -m app.eval_matcher` |
| Nhãn tên không đè nhau (GAME-09) | **PASS** — kiểm tra từng cặp nhãn trên màn hình | Playwright “M2 crowd”; `evidence/M2-crowd-labels.png` |

**Lưu ý trung thực về bộ dữ liệu:** 101 bình luận do người phát triển tự viết (không phải log LIVE thật) và luật đã được chỉnh trên chính bộ này, nên 100 % là con số lạc quan. Cần thêm bình luận thật đã ẩn danh để đo khách quan.

## Số liệu tải (T17, NFR-01) — Chrome headless + SwiftShader (CPU)

Từ bản nâng cấp đồ họa (viền cel-shading, bóng đổ mềm, render đúng độ phân giải màn hình), mỗi khung hình nặng hơn. Trên renderer CPU của môi trường test, 60 Chibi làm luồng trình duyệt quá tải, nên độ trễ đo được cũng tăng theo:

| Chỉ số | Bản đầu (đồ họa đơn giản) | Bản đồ họa mới |
| --- | --- | --- |
| Event → game ACK (lệnh không phải chờ), p50 / p95 | 473 ms / 619 ms | 12 ms / 1 448 ms |
| FPS khi 60 avatar | 2–14 | 1–2 |
| Lỗi backend / hàng đợi | 0 / 24 | 0 / ≤ 180 |

Những con số FPS và p95 này **không phải số liệu hiệu năng thật** — WebGL chạy bằng CPU. Việc bắt buộc tiếp theo là benchmark trên PC phát LIVE có GPU. Nếu máy yếu, dùng `?quality=low` (tắt viền và bóng) hoặc để chế độ tự giảm chất lượng; tối ưu instancing cho 60+ Chibi thuộc M2.

## Trạng thái tích hợp bên thứ ba (SPEC O.7)

| Tích hợp | Trạng thái |
| --- | --- |
| TikTok LIVE (TikTokLive, không chính thức) | **Unavailable** — chưa triển khai (M3) |
| Claude API | **Not tested** — chưa triển khai (M4) |
| OBS Studio Browser Source | **Not tested** trên OBS thật; trang `/game/live` đã chạy trong Chrome |
| TikTok Shop API/webhook | **Unavailable** — M6, cần quyền chính thức |

## Ảnh minh chứng

`docs/evidence/`: so sánh đồ họa trước/sau `so-sanh-overview.png`, `so-sanh-follow.png`, `so-sanh-show.png`; `T03-1-walking.png`, `T03-2-closeup-holding-box.png`, `T03-3-returned.png`, `T07-queue.png`, `T17-load.png`, `T18-after-reload.png`, `dashboard-overview.png`, `dashboard-host.png`.
