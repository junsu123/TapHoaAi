// Under a viewer's comment on the host desk: teach the owner how to answer it, or ban a word of it.
// Both are remembered: the next similar comment is answered by itself / never read.

import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { CommentRecord } from "./useDashboardFeed";

/** the words of a comment, as the host can pick them (punctuation and emoji left out) */
export function commentWords(text: string): string[] {
  const out: string[] = [];
  for (const w of text.split(/\s+/)) {
    const clean = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out.slice(0, 24);
}

export function CommentTools({ c }: { c: CommentRecord }) {
  const [mode, setMode] = useState<null | "teach" | "ban">(null);
  const [answer, setAnswer] = useState("");
  const [word, setWord] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = c.nickname ?? c.unique_id ?? "khách";
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote(await fn());
      setMode(null);
    } catch (x) {
      setNote(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comment-tools">
      <div className="row wrap">
        {!c.blocked && (
          <button type="button" className="small" aria-expanded={mode === "teach"} onClick={() => setMode(mode === "teach" ? null : "teach")} title="Chủ quán học cách trả lời bình luận này">
            Dạy chủ quán trả lời
          </button>
        )}
        <button type="button" className="small" aria-expanded={mode === "ban"} onClick={() => setMode(mode === "ban" ? null : "ban")} title="Chọn từ nhạy cảm trong bình luận này">
          Cấm từ…
        </button>
        {note && (
          <span className="small ok-text" data-testid="comment-tools-note">
            {note}
          </span>
        )}
      </div>
      {mode === "teach" && (
        <form
          className="teach-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(() =>
              api
                .post("/knowledge", { questions: [c.text], product_id: c.product_id, answer: answer.trim() })
                .then(() => "Chủ quán đã học: lần sau ai nói giống vậy, chủ quán tự trả lời câu này."),
            );
          }}
        >
          <label>
            <span className="small">Khi khách nói “{c.text}”, chủ quán trả lời:</span>
            <textarea
              rows={2}
              maxLength={300}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={`Dạ cảm ơn ${name} ạ, …`}
              aria-label="Câu chủ quán trả lời"
            />
          </label>
          <button className="primary small" disabled={busy || answer.trim().length < 2}>
            Lưu câu trả lời
          </button>
        </form>
      )}
      {mode === "ban" && (
        <form
          className="ban-form"
          onSubmit={(e) => {
            e.preventDefault();
            const w = word.trim();
            run(() =>
              api
                .post("/moderation/words", { word: w })
                .then(() => `Đã cấm “${w}”: từ nay bình luận có từ này không được đọc, chủ quán không trả lời.`),
            );
          }}
        >
          <span className="small">Bấm chọn từ nhạy cảm (chọn nhiều từ thành một cụm), hoặc gõ vào ô:</span>
          <div className="word-picks" data-testid="word-picks">
            {commentWords(c.text).map((w) => (
              <button type="button" key={w} className="small" onClick={() => setWord((cur) => (cur ? `${cur} ${w}` : w))}>
                {w}
              </button>
            ))}
          </div>
          <div className="row">
            <input value={word} onChange={(e) => setWord(e.target.value)} maxLength={40} aria-label="Từ cấm mới" placeholder="Từ hoặc cụm từ cần cấm" className="grow" />
            {word && (
              <button type="button" className="small" onClick={() => setWord("")}>
                Xoá
              </button>
            )}
            <button className="primary small" disabled={busy || word.trim().length < 2}>
              Thêm vào từ cấm
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
