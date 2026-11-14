// Dashboard → "Trợ lý AI & giọng đọc": Claude key/model/budget, shop facts, Vbee voice, LIVE switches.

import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { api, ApiError } from "../lib/api";

export interface AiConfig {
  model: string;
  budget_day_usd: number;
  budget_month_usd: number;
  max_output_tokens: number;
  shop_name: string;
  shop_facts: string;
  banned_words: string[];
  voice_enabled: boolean;
  voice_policy_confirmed: boolean;
  read_questions: boolean;
  answer_mode: "approve" | "auto";
  voice_code: string;
  voice_speed: number;
  browser_voice: boolean;
  browser_voice_name: string;
  browser_voice_rate: number;
  voice_month_chars: number;
  question_template: string;
  answer_prefix: string;
  simple_auto: boolean;
  simple_auto_speak: boolean;
  learn_enabled: boolean;
  memory_threshold: number;
  autopilot: boolean;
  auto_greet: boolean;
  auto_product: boolean;
  auto_chat: boolean;
  busy_limit: number;
  greet_templates: string[];
  product_template: string;
  chat_template: string;
  greet_joins: boolean;
  welcome_many_template: string;
  welcome_batch: number;
  read_comments: boolean;
}

export interface AiStatus {
  configured: boolean;
  model: string;
  paused: boolean;
  budget: { day_usd: number; month_usd: number; day_cap: number; month_cap: number; exhausted: boolean; tts_chars_month: number; tts_chars_cap: number };
  voice_ready: boolean;
  voice_reason: string;
  answer_mode: "approve" | "auto";
  autopilot: boolean;
  audio_note: string | null;
  greet_joins: boolean;
  read_comments: boolean;
  checks?: import("./VoiceCheck").VoiceCheckItem[];
  last_error: string | null;
  fake: boolean;
}

interface SettingsOut {
  config: AiConfig;
  secrets: { claude_api_key: string | null; vbee_app_id: string | null; vbee_token: string | null };
  models: { id: string; input_usd_per_mtok: number; output_usd_per_mtok: number }[];
  status: AiStatus;
  tts_locked: boolean;
}

interface VoiceOption {
  code: string;
  name: string;
  gender: string | null;
  language_code: string | null;
  demo: string | null;
  credit_factor: number | null;
  ownership: string | null;
}

const POLICY = [
  "Người thật vẫn dẫn LIVE; giọng AI chỉ đọc câu hỏi của khách và câu trả lời ngắn, không thay người dẫn.",
  "Khi giọng AI nói, màn hình LIVE ghi rõ “Trợ lý AI” (phần mềm tự hiện) — không giả làm người thật.",
  "Tôi đã kiểm tra giá, công bố và lưu ý của từng sản phẩm trong danh mục là đúng.",
  "Tôi biết nút “Tắt giọng ngay” (phím F9) và sẽ dùng khi cần.",
];

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
}

/** A list edited as lines; empty lines are dropped only when the field loses focus. */
function LinesInput({ value, onChange, label, rows, placeholder, commas = false }: { value: string[]; onChange: (v: string[]) => void; label: string; rows: number; placeholder?: string; commas?: boolean }) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => {
    setText((t) => (t.split("\n").map((x) => x.trim()).filter(Boolean).join("\n") === value.join("\n") ? t : value.join("\n")));
  }, [value]);
  return (
    <textarea
      rows={rows}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(commas ? /\n|,/ : "\n").map((x) => x.trim()).filter(Boolean));
      }}
      onBlur={() => setText(value.join("\n"))}
    />
  );
}

export function usd(v: number) {
  return v < 0.01 ? `${(v * 100).toFixed(3)} cent` : `${v.toFixed(2)} USD`;
}

export function AiSettingsPage() {
  const [data, setData] = useState<SettingsOut | null>(null);
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [claudeKey, setClaudeKey] = useState("");
  const [appId, setAppId] = useState("");
  const [token, setToken] = useState("");
  const [dropKey, setDropKey] = useState(false);
  const [policy, setPolicy] = useState<boolean[]>(POLICY.map(() => false));
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [claudeTest, setClaudeTest] = useState<Record<string, unknown> | null>(null);
  const [voiceText, setVoiceText] = useState("Bạn Lan Anh hỏi: trà cà gai leo giá bao nhiêu vậy shop?");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [demoUrl, setDemoUrl] = useState<string | null>(null);
  const [pcVoices, setPcVoices] = useState<{ name: string; lang: string }[] | null>(null);
  const [diag, setDiag] = useState<{ steps: { name: string; ok: boolean; detail: string; voice?: string; status?: number }[]; working_voice: string | null } | null>(null);

  const load = () =>
    api.get<SettingsOut>("/settings/ai").then((d) => {
      setData(d);
      setCfg(d.config);
      setPolicy(POLICY.map(() => d.config.voice_policy_confirmed));
    });
  useEffect(() => {
    load().catch((x) => setErr(String(x)));
    api
      .get<{ speech: { player: boolean; player_info?: { voices?: { name: string; lang: string }[] } } }>("/voice/state")
      .then((r) => setPcVoices(r.speech.player ? (r.speech.player_info?.voices ?? []) : null))
      .catch(() => undefined);
  }, []);
  if (!data || !cfg) return <p className="muted">Đang tải…</p>;

  const set = <K extends keyof AiConfig>(k: K, v: AiConfig[K]) => setCfg({ ...cfg, [k]: v });
  const allPolicy = policy.every(Boolean);

  const run = async (label: string, fn: () => Promise<void>) => {
    setErr(null);
    setMsg(null);
    setBusy(label);
    try {
      await fn();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      const body: Record<string, unknown> = { config: { ...cfg, voice_policy_confirmed: allPolicy, voice_enabled: cfg.voice_enabled && allPolicy } };
      if (claudeKey.trim()) body.claude_api_key = claudeKey.trim();
      else if (dropKey) body.claude_api_key = "";
      if (appId.trim()) body.vbee_app_id = appId.trim();
      if (token.trim()) body.vbee_token = token.trim();
      const d = await api.put<SettingsOut>("/settings/ai", body);
      setData(d);
      setCfg(d.config);
      setClaudeKey("");
      setAppId("");
      setToken("");
      setDropKey(false);
      setMsg("Đã lưu.");
    });

  const testClaude = () =>
    run("claude", async () => {
      setClaudeTest(await api.post("/settings/ai/test", { api_key: claudeKey.trim() || null, model: cfg.model }));
    });

  const testVoice = (onLive: boolean) =>
    run("voice", async () => {
      const r = await api.post<{ ok: boolean; url?: string; message: string }>("/settings/voice/test", {
        text: voiceText,
        app_id: appId.trim() || null,
        token: token.trim() || null,
        voice_code: cfg.voice_code,
        speed: cfg.voice_speed,
        on_live: onLive,
      });
      if (!r.ok) setErr(r.message);
      else {
        setMsg(r.message);
        if (r.url && !onLive) setAudioUrl(`${r.url}?t=${Date.now()}`);
      }
    });

  const loadVoices = () =>
    run("voices", async () => {
      const r = await api.post<{ ok: boolean; voices: VoiceOption[]; message: string }>("/settings/voice/list", {
        app_id: appId.trim() || null,
        token: token.trim() || null,
      });
      if (!r.ok) setErr(r.message);
      else {
        setVoices(r.voices);
        setMsg(r.message);
      }
    });
  const diagnose = () =>
    run("diag", async () => {
      setDiag(await api.post("/settings/voice/diagnose", { app_id: appId.trim() || null, token: token.trim() || null, voice_code: cfg.voice_code || null }));
    });
  const chosen = voices?.find((v) => v.code === cfg.voice_code);
  const voiceGroups: [string, VoiceOption[]][] = voices
    ? [
        ["Giọng của tôi", voices.filter((v) => v.ownership === "PERSONAL")],
        ["Giọng Vbee & cộng đồng", voices.filter((v) => v.ownership !== "PERSONAL")],
      ].filter(([, list]) => (list as VoiceOption[]).length > 0) as [string, VoiceOption[]][]
    : [];

  const st = data.status;
  const model = data.models.find((m) => m.id === cfg.model);
  return (
    <div className="stack ai-settings">
      <div className="card ai-status" data-testid="ai-status">
        <div className="row wrap">
          <span className={`chip ${st.configured ? "chip-ok" : "chip-warn"}`}>{st.configured ? "Claude: đã cài key" : "Claude: chưa cài key"}</span>
          <span className={`chip ${st.voice_ready && !st.audio_note ? "chip-ok" : "chip-warn"}`}>
            {st.voice_ready ? (st.audio_note ? `Phát trên LIVE: ${st.audio_note}` : "Giọng đọc: sẵn sàng") : `Giọng đọc: ${st.voice_reason}`}
          </span>
          <span className="chip">
            Chi phí AI hôm nay {usd(st.budget.day_usd)} / {st.budget.day_cap} USD · tháng {usd(st.budget.month_usd)} / {st.budget.month_cap} USD
          </span>
          <span className="chip">
            Ký tự giọng đọc tháng này {st.budget.tts_chars_month.toLocaleString("vi-VN")} / {st.budget.tts_chars_cap.toLocaleString("vi-VN")}
          </span>
          {st.fake && <span className="chip chip-warn">Chế độ thử (CHIBI_FAKE_AI) — không gọi Claude/Vbee thật</span>}
        </div>
        {st.last_error && <p className="error small">Lỗi Claude gần nhất: {st.last_error}</p>}
      </div>

      <div className="two-col">
        <div className="card">
          <h2>Claude — trợ lý soạn câu trả lời</h2>
          <div className="stack">
            <Field label="Claude API key" hint={data.secrets.claude_api_key ? `Đang dùng ${data.secrets.claude_api_key} — để trống nếu không đổi.` : "Lấy ở console.anthropic.com → API Keys. Key được mã hóa trên máy này, không gửi lại trình duyệt."}>
              <input type="password" autoComplete="off" value={claudeKey} onChange={(e) => setClaudeKey(e.target.value)} placeholder={data.secrets.claude_api_key ?? "sk-ant-…"} aria-label="Claude API key" />
            </Field>
            {data.secrets.claude_api_key && (
              <label className="check">
                <input type="checkbox" checked={dropKey} onChange={(e) => setDropKey(e.target.checked)} /> Gỡ key đang dùng
              </label>
            )}
            <Field label="Model" hint={model ? `Giá: ${model.input_usd_per_mtok} USD / 1 triệu token vào, ${model.output_usd_per_mtok} USD / 1 triệu token ra. Mỗi câu hỏi khoảng 1.500 token.` : undefined}>
              <select value={cfg.model} onChange={(e) => set("model", e.target.value)} aria-label="Model">
                {data.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.id === "claude-haiku-5-5" ? " (khuyên dùng — rẻ, nhanh)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <div className="row">
              <Field label="Hạn mức / ngày (USD)">
                <input type="number" min={0} step={0.1} value={cfg.budget_day_usd} onChange={(e) => set("budget_day_usd", Number(e.target.value))} aria-label="Hạn mức ngày" />
              </Field>
              <Field label="Hạn mức / tháng (USD)">
                <input type="number" min={0} step={1} value={cfg.budget_month_usd} onChange={(e) => set("budget_month_usd", Number(e.target.value))} aria-label="Hạn mức tháng" />
              </Field>
            </div>
            <p className="muted small">Hết hạn mức: game vẫn chạy, câu hỏi về giá dùng câu mẫu lấy thẳng từ danh mục.</p>
            <Field label="Tên shop (AI xưng là trợ lý của…)">
              <input value={cfg.shop_name} onChange={(e) => set("shop_name", e.target.value)} aria-label="Tên shop" />
            </Field>
            <Field label="Thông tin chung của shop" hint="Ship, thanh toán, đổi trả, giờ làm việc… AI chỉ dùng thông tin ở đây và trong danh mục sản phẩm (giá, công bố, lưu ý).">
              <textarea rows={5} value={cfg.shop_facts} onChange={(e) => set("shop_facts", e.target.value)} aria-label="Thông tin chung của shop" placeholder={"Ship toàn quốc 2–4 ngày, phí ship 30.000 đồng, miễn phí từ 2 hộp.\nNhận hàng rồi thanh toán (COD) hoặc chuyển khoản.\nĐổi trả trong 7 ngày nếu hàng lỗi."} />
            </Field>
            <Field label="Từ cấm (mỗi dòng một từ)" hint="Bình luận có từ cấm không bao giờ được đọc to.">
              <LinesInput rows={3} commas value={cfg.banned_words} onChange={(v) => set("banned_words", v)} label="Từ cấm" />
            </Field>
            <div className="row wrap">
              <button onClick={testClaude} disabled={!!busy}>
                {busy === "claude" ? "Đang thử…" : "Thử kết nối Claude"}
              </button>
            </div>
            {claudeTest && (
              <div className={`test-result ${claudeTest.ok ? "ok" : "bad"}`} data-testid="claude-test">
                <b>{String(claudeTest.message)}</b>
                {Boolean(claudeTest.ok) && (
                  <>
                    <div>Hỏi thử: {String(claudeTest.question)}</div>
                    <div>AI trả lời: “{String(claudeTest.reply)}”</div>
                    <div className="muted small">
                      {String(claudeTest.tokens_in)} token vào · {String(claudeTest.tokens_out)} token ra · {usd(Number(claudeTest.cost_usd))}
                      {claudeTest.needs_review ? " · cần người trực xem lại" : ""}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <h2>Giọng đọc Vbee</h2>
            <div className="stack">
              <Field label="App ID" hint={data.secrets.vbee_app_id ? `Đang dùng ${data.secrets.vbee_app_id}` : "Tạo ứng dụng tại vbee.vn (mục API) để lấy App ID và Token."}>
                <input autoComplete="off" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder={data.secrets.vbee_app_id ?? "App ID"} aria-label="Vbee App ID" />
              </Field>
              <Field label="Token" hint={data.secrets.vbee_token ? `Đang dùng ${data.secrets.vbee_token} — để trống nếu không đổi.` : undefined}>
                <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={data.secrets.vbee_token ?? "Token"} aria-label="Vbee Token" />
              </Field>
              <div className="field">
                <span>Giọng đọc</span>
                <div className="row wrap">
                  <button type="button" onClick={loadVoices} disabled={!!busy} data-testid="load-voices">
                    {busy === "voices" ? "Đang tải…" : voices ? "↻ Tải lại danh sách giọng" : "📋 Chọn giọng từ Vbee"}
                  </button>
                  {chosen?.demo && (
                    <button type="button" onClick={() => setDemoUrl(`${chosen.demo}`)}>
                      ▶ Nghe mẫu của Vbee
                    </button>
                  )}
                </div>
                {voices && (
                  <select value={chosen ? cfg.voice_code : ""} onChange={(e) => e.target.value && set("voice_code", e.target.value)} aria-label="Chọn giọng" data-testid="voice-select">
                    {!chosen && <option value="">— chọn một giọng ({voices.length} giọng) —</option>}
                    {voiceGroups.map(([label, list]) => (
                      <optgroup key={label} label={label}>
                        {list.map((v) => (
                          <option key={v.code} value={v.code}>
                            {v.name}
                            {v.gender ? ` · ${v.gender === "female" ? "nữ" : v.gender === "male" ? "nam" : v.gender}` : ""}
                            {v.credit_factor && v.credit_factor > 1 ? ` · ×${v.credit_factor} ký tự` : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                )}
                {demoUrl && <audio src={demoUrl} controls autoPlay />}
                <input value={cfg.voice_code} onChange={(e) => set("voice_code", e.target.value.trim())} aria-label="Mã giọng" />
                <span className="muted small">
                  Mã giọng (voiceCode) đang dùng. Bấm “Chọn giọng từ Vbee” để chọn trong danh sách giọng tài khoản của bạn được dùng — kể cả giọng bạn tự tạo — hoặc dán mã giọng vào ô này. Nhớ bấm <b>Lưu cài đặt</b>.
                </span>
              </div>
              <Field label={`Tốc độ đọc: ${cfg.voice_speed.toFixed(2)}×`}>
                <input type="range" min={0.7} max={1.4} step={0.05} value={cfg.voice_speed} onChange={(e) => set("voice_speed", Number(e.target.value))} aria-label="Tốc độ đọc" />
              </Field>
              <Field label="Hạn mức ký tự / tháng" hint="Vbee tính tiền theo ký tự. Hết hạn mức thì ngừng phát giọng, mọi thứ khác vẫn chạy.">
                <input type="number" min={0} step={10000} value={cfg.voice_month_chars} onChange={(e) => set("voice_month_chars", Number(e.target.value))} aria-label="Hạn mức ký tự" />
              </Field>
              <Field label="Câu nghe thử">
                <input value={voiceText} onChange={(e) => setVoiceText(e.target.value)} maxLength={280} aria-label="Câu nghe thử" />
              </Field>
              <div className="row wrap">
                <button onClick={() => testVoice(false)} disabled={!!busy}>
                  {busy === "voice" ? "Đang tạo giọng…" : "🔈 Nghe thử trên máy này"}
                </button>
                <button onClick={() => testVoice(true)} disabled={!!busy || !st.voice_ready}>
                  Phát thử lên LIVE (OBS)
                </button>
              </div>
              {audioUrl && <audio src={audioUrl} controls autoPlay data-testid="voice-test-audio" />}
              <div className="row wrap">
                <button type="button" onClick={diagnose} disabled={!!busy} data-testid="voice-diagnose">
                  {busy === "diag" ? "Đang kiểm tra…" : "🩺 Kiểm tra Vbee"}
                </button>
                <span className="muted small">Thử từng bước và hiện nguyên văn Vbee trả lời — chụp lại gửi người hỗ trợ nếu cần.</span>
              </div>
              {diag && (
                <div className="diag" data-testid="voice-diag">
                  {diag.steps.map((s, i) => (
                    <div key={i} className={s.ok ? "ok" : "bad"}>
                      {s.ok ? "✓" : "✗"} <b>{s.name}</b>
                      {s.voice ? <code> {s.voice}</code> : null}
                      {s.status ? <span className="muted"> (HTTP {s.status})</span> : null}
                      <div className="small">{s.detail}</div>
                    </div>
                  ))}
                  {diag.working_voice && diag.working_voice !== cfg.voice_code && (
                    <button type="button" className="primary small" onClick={() => set("voice_code", diag.working_voice!)} data-testid="use-working-voice">
                      Dùng giọng {diag.working_voice} (đọc được) — rồi bấm Lưu cài đặt
                    </button>
                  )}
                  {!diag.working_voice && <p className="error small">Không giọng nào đọc được — xem lời nhắn của Vbee ở trên (thường là App ID/Token, gói tài khoản hoặc credit).</p>}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <h2>👋 Chào người xem & đọc bình luận</h2>
            <div className="stack">
              <label className="check">
                <input type="checkbox" checked={cfg.greet_joins} onChange={(e) => set("greet_joins", e.target.checked)} aria-label="Chào người vào LIVE" />
                <span>
                  <b>Chào mọi người vào LIVE</b> — chào từng người bằng tên; nhiều người vào cùng lúc thì gộp tên vào một câu (“Chào Lan, Minh và Hoa!”), không bỏ sót ai. Ai ra rồi vào lại trong 10 phút không bị chào lại.
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={cfg.read_comments} onChange={(e) => set("read_comments", e.target.checked)} aria-label="Đọc bình luận" />
                <span>
                  <b>Đọc to bình luận của khách</b> — mọi bình luận, trừ spam, từ cấm, số điện thoại, liên kết. Câu hỏi luôn được đọc trước; bình luận thường chờ quá 30 giây thì bỏ qua để không trễ so với LIVE.
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={cfg.browser_voice} onChange={(e) => set("browser_voice", e.target.checked)} aria-label="Giọng có sẵn của máy" />
                <span>
                  <b>Chưa có Vbee hoặc Vbee lỗi: đọc bằng giọng tiếng Việt có sẵn của máy phát LIVE</b> (miễn phí). Windows: Cài đặt → Thời gian & ngôn ngữ → Giọng nói → Thêm giọng nói → Tiếng Việt, rồi mở lại OBS. Không có giọng tiếng Việt thì chỉ hiện phụ đề.
                </span>
              </label>
              {cfg.browser_voice && (
                <div className="row wrap">
                  <Field
                    label="Giọng của máy"
                    hint={
                      pcVoices === null
                        ? "Mở trang game (OBS) để thấy danh sách giọng của máy phát LIVE."
                        : pcVoices.length === 0
                          ? "Máy phát LIVE chưa có giọng tiếng Việt nào."
                          : `Máy phát LIVE có ${pcVoices.length} giọng tiếng Việt.`
                    }
                  >
                    <select value={cfg.browser_voice_name} onChange={(e) => set("browser_voice_name", e.target.value)} aria-label="Giọng của máy">
                      <option value="">Tự chọn giọng tiếng Việt</option>
                      {(pcVoices ?? []).map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name}
                        </option>
                      ))}
                      {cfg.browser_voice_name && !(pcVoices ?? []).some((v) => v.name === cfg.browser_voice_name) && <option value={cfg.browser_voice_name}>{cfg.browser_voice_name}</option>}
                    </select>
                  </Field>
                  <Field label={`Tốc độ giọng máy: ${cfg.browser_voice_rate.toFixed(1)}×`}>
                    <input type="range" min={0.5} max={1.8} step={0.1} value={cfg.browser_voice_rate} onChange={(e) => set("browser_voice_rate", Number(e.target.value))} aria-label="Tốc độ giọng máy" />
                  </Field>
                </div>
              )}
              <Field label="Câu chào nhiều người" hint="{danh_sach} = các tên, ví dụ “Lan, Minh và Hoa”; {shop} = tên shop. Một người thì dùng câu chào ở mục Tự động hoàn toàn.">
                <input value={cfg.welcome_many_template} onChange={(e) => set("welcome_many_template", e.target.value)} aria-label="Câu chào nhiều người" />
              </Field>
              <Field label={`Tối đa ${cfg.welcome_batch} tên mỗi câu chào`} hint="Đông người thì tự tăng gấp đôi; ai chờ quá 1 phút được chào chung “… và N bạn khác”.">
                <input type="range" min={2} max={12} step={1} value={cfg.welcome_batch} onChange={(e) => set("welcome_batch", Number(e.target.value))} aria-label="Số tên mỗi câu chào" />
              </Field>
            </div>
          </div>

          <div className="card">
            <h2>🤖 Tự động hoàn toàn</h2>
            <div className="stack">
              <label className="check big">
                <input type="checkbox" checked={cfg.autopilot} disabled={!allPolicy} onChange={(e) => set("autopilot", e.target.checked)} aria-label="Tự động hoàn toàn" />
                <span>
                  <b>Tự đọc bình luận và trả lời, không chờ người trực</b> — bật/tắt nhanh ở trang Người trực. Câu nói về bệnh/chữa trị, giá lạ, câu AI không chắc chắn vẫn chờ người trực.
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={cfg.auto_greet} onChange={(e) => set("auto_greet", e.target.checked)} aria-label="Chào lại khách" />
                Chào lại khách chào shop (câu mẫu, không gọi Claude)
              </label>
              <label className="check">
                <input type="checkbox" checked={cfg.auto_product} onChange={(e) => set("auto_product", e.target.checked)} aria-label="Đọc sản phẩm khách gọi" />
                Khách gọi tên sản phẩm → “Bạn … đang xem …, giá …” (giá đã xác nhận, không gọi Claude)
              </label>
              <label className="check">
                <input type="checkbox" checked={cfg.auto_chat} onChange={(e) => set("auto_chat", e.target.checked)} aria-label="Trả lời bình luận thường" />
                Bình luận thường (khen, trò chuyện) → Claude trả lời; chỉ đọc khi có câu trả lời an toàn
              </label>
              <Field label="Câu chào (mỗi dòng một câu, đọc lần lượt)" hint="{ten} = tên khách, {shop} = tên shop.">
                <LinesInput rows={3} value={cfg.greet_templates} onChange={(v) => set("greet_templates", v)} label="Câu chào" />
              </Field>
              <Field label="Câu đọc khi khách gọi sản phẩm" hint="{ten}, {san_pham}, {gia}. Sản phẩm chưa xác nhận giá thì không đọc giá.">
                <input value={cfg.product_template} onChange={(e) => set("product_template", e.target.value)} aria-label="Câu sản phẩm" />
              </Field>
              <Field label="Câu đọc bình luận thường" hint="{ten}, {binh_luan}.">
                <input value={cfg.chat_template} onChange={(e) => set("chat_template", e.target.value)} aria-label="Câu bình luận" />
              </Field>
              <Field label={`LIVE đông: bỏ qua lời chào/bình luận thường khi đã có ${cfg.busy_limit} câu chờ đọc`} hint="Câu hỏi của khách không bao giờ bị bỏ vì lý do này. Mỗi khách được chào/trả lời trò chuyện tối đa 1 lần mỗi phút.">
                <input type="range" min={1} max={8} step={1} value={cfg.busy_limit} onChange={(e) => set("busy_limit", Number(e.target.value))} aria-label="Giới hạn hàng chờ" />
              </Field>
            </div>
          </div>

          <div className="card">
            <h2>Câu đơn giản & học từ LIVE</h2>
            <div className="stack">
              <label className="check">
                <input type="checkbox" checked={cfg.learn_enabled} onChange={(e) => set("learn_enabled", e.target.checked)} aria-label="Học từ câu trả lời đã xác nhận" />
                <span>
                  <b>Học từ LIVE</b> — mỗi câu trả lời người trực bấm “Đọc” được nhớ lại. Câu Claude tự đọc (chế độ tự động) được nhớ ở dạng “chờ duyệt”.
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={cfg.simple_auto} onChange={(e) => set("simple_auto", e.target.checked)} aria-label="Câu đơn giản tự trả lời" />
                <span>
                  <b>Câu đơn giản tự trả lời, không gọi Claude</b> — câu hỏi giống câu đã học, hoặc hỏi giá sản phẩm (lấy giá đã xác nhận trong danh mục).
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={cfg.simple_auto_speak} disabled={!cfg.simple_auto} onChange={(e) => set("simple_auto_speak", e.target.checked)} aria-label="Đọc ngay câu đơn giản" />
                Đọc ngay lên LIVE, không chờ người trực bấm (các câu này đã được người trực duyệt trước đó)
              </label>
              <Field label={`Độ giống tối thiểu: ${Math.round(cfg.memory_threshold * 100)}%`} hint="Cao hơn = chỉ tự trả lời khi câu hỏi rất giống; thấp hơn = tự trả lời nhiều hơn nhưng dễ trả lời nhầm.">
                <input type="range" min={0.6} max={0.95} step={0.05} value={cfg.memory_threshold} onChange={(e) => set("memory_threshold", Number(e.target.value))} aria-label="Độ giống tối thiểu" />
              </Field>
              <NavLink to="/dashboard/knowledge" className="small">
                Xem lịch sử hội thoại và các câu đã học →
              </NavLink>
            </div>
          </div>

          <div className="card">
            <h2>Phát giọng trên LIVE</h2>
            {data.tts_locked && <p className="error">Giọng đọc đang bị khóa bằng CHIBI_TTS_LOCKED=1.</p>}
            <div className="stack">
              <p className="muted small">Mặc định tắt (tài liệu thiết kế AI-06). Đánh dấu đủ các mục dưới đây mới bật được:</p>
              {POLICY.map((t, i) => (
                <label className="check" key={i}>
                  <input type="checkbox" checked={policy[i]} onChange={(e) => setPolicy(policy.map((v, j) => (j === i ? e.target.checked : v)))} aria-label={`Chính sách ${i + 1}`} />
                  {t}
                </label>
              ))}
              <label className="check big">
                <input type="checkbox" checked={cfg.voice_enabled && allPolicy} disabled={!allPolicy} onChange={(e) => set("voice_enabled", e.target.checked)} aria-label="Bật giọng đọc trên LIVE" />
                <b>Bật phát trên LIVE</b> (giọng đọc; chưa có giọng hoặc giọng lỗi thì hiện phụ đề)
              </label>
              <label className="check">
                <input type="checkbox" checked={cfg.read_questions} onChange={(e) => set("read_questions", e.target.checked)} aria-label="Đọc to câu hỏi của khách" />
                Đọc to câu hỏi của khách (bỏ số điện thoại, liên kết; không đọc bình luận có từ cấm)
              </label>
              <Field label="Mẫu câu đọc câu hỏi" hint="{ten} = tên khách, {cau_hoi} = câu hỏi.">
                <input value={cfg.question_template} onChange={(e) => set("question_template", e.target.value)} aria-label="Mẫu câu hỏi" />
              </Field>
              <fieldset className="radio-group">
                <legend>Câu trả lời của Claude được đọc khi nào?</legend>
                <label className="check">
                  <input type="radio" name="mode" checked={cfg.answer_mode === "approve"} onChange={() => set("answer_mode", "approve")} aria-label="Người trực duyệt" />
                  <span>
                    <b>Người trực bấm “Đọc”</b> (khuyên dùng) — xem, sửa nếu cần rồi mới phát.
                  </span>
                </label>
                <label className="check">
                  <input type="radio" name="mode" checked={cfg.answer_mode === "auto"} onChange={() => set("answer_mode", "auto")} aria-label="Tự động đọc" />
                  <span>
                    <b>Tự động đọc ngay</b> — chỉ những câu an toàn; câu có nói về bệnh/chữa trị, giá lạ hoặc AI không chắc chắn vẫn chờ người trực.
                  </span>
                </label>
              </fieldset>
              <Field label="Mở đầu câu trả lời (tùy chọn)" hint="Ví dụ “Dạ,”. Để trống nếu Claude đã tự mở đầu.">
                <input value={cfg.answer_prefix} onChange={(e) => set("answer_prefix", e.target.value)} aria-label="Mở đầu câu trả lời" />
              </Field>
            </div>
          </div>
        </div>
      </div>

      <div className="save-bar">
        <button className="primary" onClick={save} disabled={!!busy}>
          {busy === "save" ? "Đang lưu…" : "Lưu cài đặt"}
        </button>
        {msg && <span className="ok-text">{msg}</span>}
        {err && (
          <span className="error" role="alert">
            {err}
          </span>
        )}
      </div>
    </div>
  );
}
