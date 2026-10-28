import { deferred, readStatus, until } from "../../__tests__/readiness-http";

const mockServers: any[] = [];
const mockCreateQueues = jest.fn();
const mockRegister = jest.fn();
jest.mock("../queues", () => ({
  createMaintenanceQueues: () => mockCreateQueues(),
}));
jest.mock("../scheduler-registration", () => ({
  registerMaintenanceSchedulers: (...args: unknown[]) => mockRegister(...args),
}));
jest.mock("../../utils/sentry-initialization", () => ({
  initializeBackendSentry: jest.fn(),
}));
jest.mock("../readiness", () => {
  const actual = jest.requireActual("../readiness");
  return {
    ...actual,
    startBackgroundReadiness: async (probe: () => Promise<boolean>) => {
      const server = await actual.startBackgroundReadiness(probe, {
        port: 0,
        timeoutMs: 100,
      });
      mockServers.push(server);
      return server;
    },
  };
});

import { startMaintenanceScheduler } from "../scheduler";
import type { BackgroundProcess } from "../readiness";

describe("scheduler readiness lifecycle", () => {
  let queues: any[];
  let registration: ReturnType<typeof deferred<void>>;
  let runtime: BackgroundProcess | undefined;
  let intervals: (() => void)[];
  let intervalSpy: jest.SpyInstance;
  const realSetInterval = global.setInterval;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServers.length = 0;
    queues = Array.from({ length: 3 }, () => {
      const ready = deferred<any>();
      const client = {
        status: "ready",
        ping: jest.fn().mockResolvedValue("PONG"),
      };
      return {
        ready,
        clientState: client,
        client: Promise.resolve(client),
        waitUntilReady: jest.fn(() => ready.promise),
        on: jest.fn().mockReturnThis(),
        getJobCounts: jest.fn().mockResolvedValue({}),
        close: jest.fn().mockResolvedValue(undefined),
      };
    });
    mockCreateQueues.mockReturnValue({
      commerce: queues[0],
      analytics: queues[1],
      payments: queues[2],
    });
    registration = deferred<void>();
    mockRegister.mockReturnValue(registration.promise);
    runtime = undefined;
    intervals = [];
    intervalSpy = jest.spyOn(global, "setInterval").mockImplementation(((
      callback: () => void,
      delay: number,
    ) => {
      intervals.push(callback);
      return realSetInterval(callback, delay);
    }) as typeof setInterval);
  });
  afterEach(async () => {
    await runtime?.close();
    await Promise.all(mockServers.map((server) => server.close()));
    intervalSpy.mockRestore();
  });

  async function boot() {
    const started = startMaintenanceScheduler();
    await until(() => mockServers.length === 1);
    expect((await readStatus(mockServers[0].port)).status).toBe(503);
    expect(mockRegister).not.toHaveBeenCalled();
    for (const queue of queues) queue.ready.resolve(queue.clientState);
    await until(() => mockRegister.mock.calls.length === 1);
    expect((await readStatus(mockServers[0].port)).status).toBe(503);
    registration.resolve();
    runtime = await started;
    return mockServers[0].port;
  }

  it("waits for queue connections and the entire registration batch", async () => {
    const port = await boot();
    expect((await readStatus(port)).status).toBe(200);
    queues[2].clientState.status = "reconnecting";
    expect((await readStatus(port)).status).toBe(503);
    queues[2].clientState.status = "ready";
    expect((await readStatus(port)).status).toBe(200);
  });

  it("becomes unready on a failed reassertion and recovers after a complete retry", async () => {
    const port = await boot();
    mockRegister.mockRejectedValueOnce(new Error("registration failed"));
    intervals[0]();
    await new Promise(setImmediate);
    expect((await readStatus(port)).status).toBe(503);
    mockRegister.mockResolvedValueOnce(undefined);
    intervals[0]();
    await new Promise(setImmediate);
    expect((await readStatus(port)).status).toBe(200);
  });

  it("shares reassertions, marks unready before shutdown, and drains registration", async () => {
    const port = await boot();
    const pending = deferred<void>();
    mockRegister.mockReturnValue(pending.promise);
    intervals[0]();
    intervals[0]();
    expect(mockRegister).toHaveBeenCalledTimes(2);
    const closed = runtime!.close();
    expect(runtime!.close()).toBe(closed);
    expect((await readStatus(port)).status).toBe(503);
    for (const queue of queues) expect(queue.close).not.toHaveBeenCalled();
    intervals[0]();
    expect(mockRegister).toHaveBeenCalledTimes(2);
    pending.resolve();
    await closed;
    for (const queue of queues) expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up when initial registration fails", async () => {
    const started = startMaintenanceScheduler();
    const rejected = expect(started).rejects.toThrow("registration failed");
    await until(() => mockServers.length === 1);
    for (const queue of queues) queue.ready.resolve(queue.clientState);
    await until(() => mockRegister.mock.calls.length === 1);
    registration.reject(new Error("registration failed"));
    await rejected;
    for (const queue of queues) expect(queue.close).toHaveBeenCalledTimes(1);
    await expect(readStatus(mockServers[0].port)).rejects.toThrow();
  });

  it("drains a shutdown during initial registration without starting timers", async () => {
    const previous = new Set(process.listeners("SIGTERM"));
    const exit = jest
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    try {
      const started = startMaintenanceScheduler();
      await until(() => mockServers.length === 1);
      for (const queue of queues) queue.ready.resolve(queue.clientState);
      await until(() => mockRegister.mock.calls.length === 1);
      const shutdown = process
        .listeners("SIGTERM")
        .find((fn) => !previous.has(fn))!;
      shutdown();
      expect((await readStatus(mockServers[0].port)).status).toBe(503);
      for (const queue of queues) expect(queue.close).not.toHaveBeenCalled();
      registration.resolve();
      runtime = await started;
      await until(() => exit.mock.calls.length > 0);
      expect(exit).toHaveBeenCalledWith(0);
      expect(intervals).toHaveLength(0);
      for (const queue of queues) expect(queue.close).toHaveBeenCalledTimes(1);
    } finally {
      exit.mockRestore();
    }
  });
});
