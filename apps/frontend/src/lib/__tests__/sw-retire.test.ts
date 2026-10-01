/** @jest-environment node */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

it("retires its own registration, preserves unrelated caches and never navigates shoppers", async () => {
  const listeners: Record<
    string,
    (event: { waitUntil: (task: Promise<unknown>) => void }) => void
  > = {};
  const remove = jest.fn().mockResolvedValue(true),
    unregister = jest.fn().mockResolvedValue(true);
  const claim = jest.fn().mockResolvedValue(undefined),
    skipWaiting = jest.fn().mockResolvedValue(undefined);
  runInNewContext(readFileSync(resolve(process.cwd(), "public/sw-retire.js"), "utf8"), {
    self: {
      addEventListener: (type: string, listener: (typeof listeners)[string]) => {
        listeners[type] = listener;
      },
      skipWaiting,
      clients: { claim },
      registration: { unregister },
    },
    caches: {
      keys: async () => ["runtime-cache-v123", "runtime-cache-v456", "unrelated-cache"],
      delete: remove,
    },
  });
  expect(Object.keys(listeners)).toEqual(["install", "activate"]);
  let task: Promise<unknown> = Promise.resolve();
  const event = {
    waitUntil: (next: Promise<unknown>) => {
      task = next;
    },
  };
  listeners.install(event);
  await task;
  listeners.activate(event);
  await task;
  expect(skipWaiting).toHaveBeenCalledTimes(1);
  expect(claim).toHaveBeenCalledTimes(1);
  expect(remove.mock.calls).toEqual([["runtime-cache-v123"], ["runtime-cache-v456"]]);
  expect(unregister).toHaveBeenCalledTimes(1);
});
