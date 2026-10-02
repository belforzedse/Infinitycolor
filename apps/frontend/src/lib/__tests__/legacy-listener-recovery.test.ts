import { getLegacyRuntimePolyfillScript } from "../legacyRuntimePolyfills";

const originalAdd = window.addEventListener;
const originalRemove = window.removeEventListener;
beforeEach(() => {
  window.addEventListener = originalAdd;
  window.removeEventListener = originalRemove;
});
afterEach(() => {
  window.addEventListener = originalAdd;
  window.removeEventListener = originalRemove;
});

function injectedError(mixed = false): Error {
  const error = new TypeError("Cannot read properties of null (reading 'tagName')");
  error.stack = mixed
    ? "TypeError\n at firstParty (app.js:1:1)"
    : "TypeError\n at addEL_hook (<anonymous>:675:29)\n at top.addEventListener (<anonymous>:695:9)";
  return error;
}
it.each(["popstate", "pageshow"])(
  "recovers only the verified injected %s registration and cleans it up",
  (type) => {
    window.addEventListener = function (...args: Parameters<typeof originalAdd>) {
      if (args[0] === type) throw injectedError();
      return originalAdd.apply(this, args);
    } as typeof originalAdd;
    new Function(getLegacyRuntimePolyfillScript())();
    const listener = jest.fn();
    window.addEventListener(type, listener, { capture: true });
    window.dispatchEvent(new Event(type));
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(type, listener, { capture: true });
    window.dispatchEvent(new Event(type));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(
      (window as unknown as { __infinityListenerRecovery: Record<string, boolean> })
        .__infinityListenerRecovery[type],
    ).toBe(true);
  },
);
it.each(["popstate", "click"])("retains unknown or out-of-scope %s errors", (type) => {
  const error = injectedError(type === "popstate");
  window.addEventListener = (() => {
    throw error;
  }) as typeof originalAdd;
  new Function(getLegacyRuntimePolyfillScript())();
  expect(() => window.addEventListener(type, jest.fn())).toThrow(error);
});
it("keeps normal registration unchanged", () => {
  new Function(getLegacyRuntimePolyfillScript())();
  const listener = jest.fn();
  window.addEventListener("popstate", listener);
  window.dispatchEvent(new Event("popstate"));
  window.removeEventListener("popstate", listener);
  expect(listener).toHaveBeenCalledTimes(1);
});
