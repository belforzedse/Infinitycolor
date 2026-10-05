import { getLegacyRuntimePolyfillScript } from "../legacyRuntimePolyfills";

function legacy() {
  class LegacyPromise<T> extends Promise<T> {}
  Object.defineProperty(LegacyPromise, "allSettled", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  const browser: { queueMicrotask?: (callback: () => void) => void; structuredClone?: unknown } =
    {};
  const timers: Array<() => void> = [];
  new Function("window", "Promise", "setTimeout", getLegacyRuntimePolyfillScript())(
    browser,
    LegacyPromise,
    (callback: () => void) => {
      timers.push(callback);
    },
  );
  return { browser, Promise: LegacyPromise as typeof Promise, timers };
}
it("schedules microtasks in order and surfaces callback exceptions as ordinary errors", async () => {
  const { browser, timers } = legacy();
  const order: string[] = [];
  browser.queueMicrotask!(() => {
    order.push("first");
  });
  browser.queueMicrotask!(() => {
    order.push("second");
    throw new Error("callback failure");
  });
  order.push("synchronous");
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual(["synchronous", "first", "second"]);
  expect(timers).toHaveLength(1);
  expect(timers[0]).toThrow("callback failure");
  expect(() => browser.queueMicrotask!(null as never)).toThrow(TypeError);
});
it("preserves input ordering, thenable assimilation, rejection reasons and empty iterables", async () => {
  const environment = legacy();
  let resolve!: (value: number) => void;
  const first = new Promise<number>((done) => {
    resolve = done;
  });
  const rejected = Promise.reject("reason");
  rejected.catch(() => undefined);
  const result = environment.Promise.allSettled(
    new Set([first, rejected, { then: (done: (value: number) => void) => done(3) }]),
  );
  resolve(1);
  await expect(result).resolves.toEqual([
    { status: "fulfilled", value: 1 },
    { status: "rejected", reason: "reason" },
    { status: "fulfilled", value: 3 },
  ]);
  await expect(environment.Promise.allSettled([])).resolves.toEqual([]);
  await expect(environment.Promise.allSettled({ length: 0 } as never)).rejects.toBeInstanceOf(
    TypeError,
  );
});
it("leaves installed native APIs untouched", () => {
  const queue = jest.fn();
  const settled = Promise.allSettled;
  new Function("window", getLegacyRuntimePolyfillScript())({ queueMicrotask: queue });
  expect(Promise.allSettled).toBe(settled);
});
