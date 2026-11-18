// "Hội thoại & câu đã học" → "Từ cấm & nhắc nhở": the shop's banned words (also taught from a
// comment on the host desk), what the owner does when a viewer uses one, the comments caught, and
// the viewers muted for this LIVE.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";

interface Caught {
  at: string;
  name: string | null;
  text: string;
  word: string | null;
  reminded: boolean;
  muted: boolean;
  is_demo: boolean;
}
export interface ModerationView {
  words: string[];
  builtin: string[];
  action: "skip" | "remind";
  remind_template: string;
  mute_after: number;
  recent: Caught[];
  blocked_total: number;
  muted: { key: string; name: string }[];
}

const time = (iso: string) => new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

export function ModerationTab() {
  const [v, setV] = useState<ModerationView | null>(null);
  const [word, setWord] = useState("");
  const [rule, setRule] = useState<Pick<ModerationView, "action" | "remind_template" | "mute_after"> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => api.get<ModerationView>("/moderation").then(setV), []);
  useEffect(() => {
    load().then(() => undefined);
    const t = setInterval(load, 4000); // comments caught during the LIVE
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (v && !rule) setRule({ action: v.action, remind_template: v.remind_template, mute_after: v.mute_after });
  }, [v, rule]);
  const call = (p: Promise<ModerationView>, done: string) =>
    p.then((r) => {
      setV(r);
      setNote(done);
    }).catch((x) => setNote(x instanceof ApiError ? x.message : String(x)));
  if (!v || !rule) return <p className="muted">Đang tải…</p>;
  return (
    <div className="stack" data-testid="moderation">
      <div className="card stack">
        <h3>Từ cấm của shop</h3>
        <p className="muted small">
          Bình luận có từ cấm không bao giờ được đọc to, chủ quán không trả lời và không học từ bình luận đó. Viết có dấu hay không dấu, hoa hay thường đều bắt được. Thêm từ ở đây, hoặc bấm “Cấm từ…” dưới
          bình luận của khách ở trang Người trực.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const w = word.trim();
            call(api.post<ModerationView>("/moderation/words", { word: w }), `Đã thêm “${w}”.`).then(() => setWord(""));
          }}
        >
          <input value={word} onChange={(e) => setWord(e.target.value)} maxLength={40} placeholder="Từ hoặc cụm từ cần cấm" aria-label="Thêm từ cấm" className="grow" />
          <button className="primary" disabled={word.trim().length < 2}>
            Thêm từ cấm
          </button>
        </form>
        <div className="banned-list" data-testid="banned-list">
          {v.words.length === 0 && <span className="muted small">Chưa có từ nào. Danh sách có sẵn bên dưới vẫn luôn được dùng.</span>}
          {v.words.map((w) => (
            <span key={w} className="account-chip">
              <span className="bw">{w}</span>
              <button
                type="button"
                className="forget"
                aria-label={`Bỏ từ cấm ${w}`}
                onClick={() => call(api.del<ModerationView>(`/moderation/words?word=${encodeURIComponent(w)}`), `Đã bỏ “${w}”.`)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <details>
          <summary className="small">Từ chửi tục có sẵn ({v.builtin.length} từ, luôn bị chặn)</summary>
          <p className="muted small">{v.builtin.join(", ")}</p>
        </details>
      </div>

      <div className="card stack">
        <h3>Khi khách dùng từ cấm</h3>
        <label className="check">
          <input type="radio" name="banned-action" checked={rule.action === "remind"} onChange={() => setRule({ ...rule, action: "remind" })} />
          Không đọc, chủ quán nhắc nhở nhẹ nhàng (gọi tên, không nhắc lại từ đó; mỗi người tối đa 1 lần / 5 phút)
        </label>
        <label className="check">
          <input type="radio" name="banned-action" checked={rule.action === "skip"} onChange={() => setRule({ ...rule, action: "skip" })} />
          Không đọc, bỏ qua im lặng
        </label>
        {rule.action === "remind" && (
          <label>
            <span className="small">Câu nhắc nhở ({"{ten}"} = tên người xem)</span>
            <input value={rule.remind_template} maxLength={160} onChange={(e) => setRule({ ...rule, remind_template: e.target.value })} aria-label="Câu nhắc nhở" />
          </label>
        )}
        <label>
          <span className="small">Tạm không đọc mọi bình luận của người đã dùng từ cấm từ lần thứ (0 = không bao giờ), tới hết buổi LIVE</span>
          <input type="number" min={0} max={20} value={rule.mute_after} onChange={(e) => setRule({ ...rule, mute_after: Number(e.target.value) })} aria-label="Tạm không đọc từ lần thứ" />
        </label>
        <div className="row">
          <button className="primary" onClick={() => call(api.put<ModerationView>("/moderation", rule), "Đã lưu.")}>
            Lưu cách xử lý
          </button>
          {note && (
            <span className="small ok-text" data-testid="moderation-note">
              {note}
            </span>
          )}
        </div>
      </div>

      {v.muted.length > 0 && (
        <div className="card stack">
          <h3>Đang tạm không đọc bình luận (buổi LIVE này)</h3>
          <ul className="plain">
            {v.muted.map((m) => (
              <li key={m.key} className="row">
                <b>{m.name}</b>
                <button className="small" onClick={() => call(api.post<ModerationView>("/moderation/unmute", { key: m.key }), `Đã cho đọc lại bình luận của ${m.name}.`)}>
                  Cho đọc lại
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card stack">
        <h3>Bình luận đã chặn gần đây {v.blocked_total > 0 && <span className="chip">{v.blocked_total} từ khi mở phần mềm</span>}</h3>
        {v.recent.length === 0 ? (
          <p className="muted small">Chưa chặn bình luận nào.</p>
        ) : (
          <table className="conv-table" data-testid="blocked-table">
            <thead>
              <tr>
                <th>Lúc</th>
                <th>Khách</th>
                <th>Bình luận</th>
                <th>Từ cấm</th>
                <th>Chủ quán</th>
              </tr>
            </thead>
            <tbody>
              {v.recent.map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td className="small">{time(r.at)}</td>
                  <td>
                    {r.name ?? "?"}
                    {r.is_demo && <span className="chip">DEMO</span>}
                  </td>
                  <td>{r.text}</td>
                  <td>{r.word ?? <span className="muted">(đang tạm không đọc)</span>}</td>
                  <td className="small">{r.reminded ? "Đã nhắc nhở" : r.muted ? "Tạm không đọc" : "Bỏ qua"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
