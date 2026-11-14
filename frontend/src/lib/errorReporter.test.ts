import { beforeEach, describe, expect, it, vi } from "vitest";

describe("errorReporter", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))));
    vi.stubGlobal("location", { pathname: "/game/live" });
    vi.stubGlobal("window", new EventTarget());
  });

  it("sends each error once per 10 s and at most 30 per page", async () => {
    const { reportError } = await import("./errorReporter");
    reportError("error", "boom", "stack");
    reportError("error", "boom", "stack");
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ page: "dashboard", kind: "error", message: "boom", stack: "stack" });
    for (let i = 0; i < 50; i++) reportError("error", `e${i}`);
    expect(fetch).toHaveBeenCalledTimes(30);
  });

  it("reports uncaught errors and rejected promises of the page", async () => {
    const { installErrorReporter } = await import("./errorReporter");
    installErrorReporter("game");
    window.dispatchEvent(Object.assign(new Event("error"), { message: "x is undefined", error: new TypeError("x is undefined") }));
    const ev = new Event("unhandledrejection") as Event & { reason: unknown };
    ev.reason = new Error("fetch failed");
    window.dispatchEvent(ev);
    const bodies = vi.mocked(fetch).mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies.map((b) => [b.page, b.kind, b.message])).toEqual([
      ["game", "error", "TypeError: x is undefined"],
      ["game", "unhandledrejection", "Error: fetch failed"],
    ]);
  });
});
