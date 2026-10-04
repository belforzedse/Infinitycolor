import { getLegacyRuntimePolyfillScript } from "../legacyRuntimePolyfills";

const addDescriptor = Object.getOwnPropertyDescriptor(window, "addEventListener");
const removeDescriptor = Object.getOwnPropertyDescriptor(window, "removeEventListener");
const stringify = Function.prototype.toString;
const originalAdd = window.addEventListener;
const originalRemove = window.removeEventListener;
function restore() {
  if (addDescriptor) Object.defineProperty(window, "addEventListener", addDescriptor);
  else delete (window as any).addEventListener;
  if (removeDescriptor) Object.defineProperty(window, "removeEventListener", removeDescriptor);
  else delete (window as any).removeEventListener;
  delete (window as any).__infinityListenerGuard;
}
beforeEach(() => {
  restore();
  jest.spyOn(Function.prototype, "toString").mockImplementation(function (
    this: (...args: never[]) => unknown,
  ) {
    if (
      this === EventTarget.prototype.addEventListener ||
      this === EventTarget.prototype.removeEventListener
    )
      return "function () { [native code] }";
    return stringify.call(this);
  });
  window.addEventListener = originalAdd;
  window.removeEventListener = originalRemove;
});
afterEach(() => {
  restore();
  jest.restoreAllMocks();
});

function injectedError(mixed = false): Error {
  const error = new TypeError("Cannot read properties of null (reading 'tagName')");
  error.stack = mixed
    ? "TypeError\n at firstParty (app.js:1:1)"
    : "TypeError\n at addEL_hook (<anonymous>:675:29)\n at top.addEventListener (<anonymous>:695:9)";
  return error;
}
it.each(["popstate", "pageshow", "resize", "focus"])(
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

it("recovers hooks assigned after bootstrap without SDK wrapper recursion", () => {
  new Function(getLegacyRuntimePolyfillScript())();
  const previous = window.addEventListener;
  window.addEventListener = function (type, listener, options) {
    if (type === "resize") throw injectedError();
    return previous.call(this, type, listener, options);
  };
  const dependency = window.addEventListener;
  window.addEventListener = function (type, listener, options) {
    return dependency.call(this, type, listener, options);
  };
  const listener = jest.fn();
  window.addEventListener("resize", listener);
  window.dispatchEvent(new Event("resize"));
  window.removeEventListener("resize", listener);
  window.dispatchEvent(new Event("resize"));
  expect(listener).toHaveBeenCalledTimes(1);
});

it("retains a first-party throwing frame even with injected frames below it", () => {
  const error = injectedError();
  error.stack =
    "TypeError\n at application (/_next/static/app.js:1:1)\n at addEL_hook (<anonymous>:675:29)\n at top.addEventListener (<anonymous>:695:9)";
  new Function(getLegacyRuntimePolyfillScript())();
  window.addEventListener = () => {
    throw error;
  };
  expect(() => window.addEventListener("focus", jest.fn())).toThrow(error);
});
