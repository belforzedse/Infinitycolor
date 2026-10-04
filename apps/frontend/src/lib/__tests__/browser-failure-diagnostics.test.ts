import {
  browserFailureSnapshot,
  installBrowserFailureDiagnostics,
  recordBrowserHandler,
} from "../browser-failure-diagnostics";
it("bounds diagnostics, omits rejection values and resource query strings, and never consumes errors", () => {
  const added: Array<[string, EventListener, boolean | AddEventListenerOptions | undefined]> = [];
  const native = window.addEventListener;
  const spy = jest
    .spyOn(window, "addEventListener")
    .mockImplementation((type, callback, options) => {
      added.push([type, callback as EventListener, options]);
      native.call(window, type, callback, options);
    });
  try {
    installBrowserFailureDiagnostics();
    for (let count = 0; count < 100; count++) {
      recordBrowserHandler("search_route");
      const event = new Event("unhandledrejection", { cancelable: true });
      Object.defineProperty(event, "reason", {
        value: { name: "private@example.test", token: "private-token" },
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    const script = document.createElement("script");
    script.src = "/_next/static/chunks/test.js?private-token";
    const error = new Event("error", { cancelable: true });
    Object.defineProperty(error, "target", { value: script });
    window.dispatchEvent(error);
    const snapshot = browserFailureSnapshot();
    expect(snapshot.failures).toHaveLength(8);
    expect(snapshot.handlers).toEqual({ search_route: 64 });
    expect(JSON.stringify(snapshot)).toContain("/_next/static/chunks/test.js");
    expect(JSON.stringify(snapshot)).not.toMatch(/private|token|email/);
    expect(error.defaultPrevented).toBe(false);
  } finally {
    spy.mockRestore();
    for (const [type, callback, options] of added)
      window.removeEventListener(type, callback, options);
  }
});
