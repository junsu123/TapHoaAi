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

  const load = () =>
    api.get<SettingsOut>("/settings/ai").then((d) => {
      setData(d);
      setCfg(d.config);
      setPolicy(POLICY.map(() => d.config.voice_policy_confirmed));
    });
  useEffect(() => {
    load().catch((x) => setErr(String(x)));
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

  const st = data.status;
  const model = data.models.find((m) => m.id === cfg.model);
  return (
    <div className="stack ai-settings">
      <div className="card ai-status" data-testid="ai-status">
        <div className="row wrap">
          <span className={`chip ${st.configured ? "chip-ok" : "chip-warn"}`}>{st.configured ? "Claude: đã cài key" : "Claude: chưa cài key"}</span>
          <span className={`chip ${st.voice_ready ? "chip-ok" : "chip-warn"}`}>{st.voice_ready ? "Giọng đọc: sẵn sàng" : `Giọng đọc: ${st.voice_reason}`}</span>
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
              <Field label="Mã giọng (voiceCode)" hint="Mặc định là “HN - Ngọc Huyền”. Giọng khác (SG - Tường Vy, HN - Mai Phương, SG - Lan Trinh, SG - Thảo Trinh…): chép mã giọng trong trang Vbee.">
                <input value={cfg.voice_code} onChange={(e) => set("voice_code", e.target.value.trim())} aria-label="Mã giọng" />
              </Field>
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
                <b>Bật giọng đọc trên LIVE</b>
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
