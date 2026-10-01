import { listenMediaQuery } from "../media-query-listener";
import { getLegacyRuntimePolyfillScript } from "../legacyRuntimePolyfills";

it("pairs modern and legacy listener registration with the corresponding cleanup", () => {
  const listener = jest.fn();
  for (const modern of [true, false]) {
    const add = jest.fn(),
      remove = jest.fn();
    const query = (modern
      ? { addEventListener: add, removeEventListener: remove }
      : { addListener: add, removeListener: remove }) as unknown as MediaQueryList;
    const cleanup = listenMediaQuery(query, listener);
    expect(add).toHaveBeenCalledWith(...(modern ? ["change", listener] : [listener]));
    cleanup();
    expect(remove).toHaveBeenCalledWith(...(modern ? ["change", listener] : [listener]));
  }
});
it("guards dependency calls before hydration without replacing modern APIs", () => {
  const proto = { addListener: jest.fn(), removeListener: jest.fn() };
  const query = Object.create(proto);
  const original = window.matchMedia;
  window.matchMedia = () => query;
  try {
    window.eval(getLegacyRuntimePolyfillScript());
    const listener = jest.fn();
    query.addEventListener("change", listener);
    query.removeEventListener("change", listener);
    expect(proto.addListener).toHaveBeenCalledWith(listener);
    expect(proto.removeListener).toHaveBeenCalledWith(listener);
    const add = query.addEventListener;
    window.eval(getLegacyRuntimePolyfillScript());
    expect(query.addEventListener).toBe(add);
  } finally {
    window.matchMedia = original;
  }
});
