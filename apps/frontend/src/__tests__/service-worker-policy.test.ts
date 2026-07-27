import fs from "node:fs";
import path from "node:path";

describe("service worker privacy boundary", () => {
  it("does not intercept authenticated or commerce routes", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const source = fs.readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8");
    const listeners = new Map<string, (event: unknown) => void>();
    const worker = {
      __INFINITY_BUILD_VERSION__: "test",
      origin: "https://shop.example.test",
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        listeners.set(name, handler),
      skipWaiting: jest.fn(),
      clients: {
        claim: jest.fn(),
        matchAll: jest.fn().mockResolvedValue([]),
      },
    };

    const evaluate = new Function(
      "self",
      "caches",
      "indexedDB",
      "importScripts",
      source,
    );
    evaluate(
      worker,
      { keys: jest.fn().mockResolvedValue([]) },
      undefined,
      jest.fn(),
    );
    warnSpy.mockRestore();
    logSpy.mockRestore();

    const fetchHandler = listeners.get("fetch");
    expect(fetchHandler).toBeDefined();

    for (const pathname of [
      "/api/users/me",
      "/account",
      "/cart",
      "/checkout",
      "/orders/42",
      "/wallet",
      "/super-admin/orders",
    ]) {
      const respondWith = jest.fn();
      fetchHandler?.({
        request: {
          method: "GET",
          url: `https://shop.example.test${pathname}`,
          headers: new Headers(),
        },
        respondWith,
      });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });
});
