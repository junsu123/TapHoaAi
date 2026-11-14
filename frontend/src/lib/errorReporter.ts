// Sends JavaScript errors of this page to the server's error log (Dashboard → Nhật ký lỗi).
// Same error repeated within 10 s is sent once; at most 30 reports per page load, so a broken
// render loop cannot flood the server.

export type ReportPage = "game" | "dashboard";
export type ReportKind = "error" | "unhandledrejection" | "react" | "webgl" | "network" | "warning";

let page: ReportPage = "dashboard";
let sent = 0;
const recent = new Map<string, number>();
const MAX_REPORTS = 30;

export function reportError(kind: ReportKind, message: string, stack?: string | null): void {
  const key = `${kind}|${message}`;
  const now = Date.now();
  if ((recent.get(key) ?? 0) > now - 10_000 || sent >= MAX_REPORTS) return;
  recent.set(key, now);
  sent += 1;
  const body = JSON.stringify({
    page,
    kind,
    message: (message || "(không có nội dung)").slice(0, 1000),
    stack: stack ? stack.slice(0, 8000) : null,
    url: location.pathname.slice(0, 300),
    user_agent: navigator.userAgent.slice(0, 300),
  });
  try {
    void fetch("/api/v1/logs/client", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true, credentials: "same-origin" }).catch(() => undefined);
  } catch {
    /* reporting must never throw */
  }
}

function describe(reason: unknown): { message: string; stack: string | null } {
  if (reason instanceof Error) return { message: `${reason.name}: ${reason.message}`, stack: reason.stack ?? null };
  try {
    return { message: typeof reason === "string" ? reason : JSON.stringify(reason), stack: null };
  } catch {
    return { message: String(reason), stack: null };
  }
}

export function installErrorReporter(p: ReportPage): void {
  page = p;
  window.addEventListener("error", (e) => {
    // a <script>/<img> that failed to load has no message; the server logs missing files itself
    if (!e.message && !(e.error instanceof Error)) return;
    const d = e.error ? describe(e.error) : { message: e.message, stack: `${e.filename}:${e.lineno}:${e.colno}` };
    reportError("error", d.message, d.stack);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const d = describe(e.reason);
    reportError("unhandledrejection", d.message, d.stack);
  });
}
