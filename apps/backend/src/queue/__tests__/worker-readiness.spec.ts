import { deferred, readStatus, until } from "../../__tests__/readiness-http";

const mockWorkers: any[] = [];
const mockServers: any[] = [];
const mockLoad = jest.fn();
const mockTerminate = jest.fn().mockResolvedValue(undefined);

jest.mock("bullmq", () => ({
  Worker: jest.fn((name: string) => {
    const ready = deferred<any>();
    const client = {
      status: "ready",
      ping: jest.fn().mockResolvedValue("PONG"),
    };
    const blocking = { status: "ready", ping: jest.fn() };
    const worker = {
      name,
      ready,
      clientState: client,
      blocking,
      client: Promise.resolve(client),
      waitUntilReady: jest.fn(() => ready.promise),
      isRunning: jest.fn(() => true),
      isPaused: jest.fn(() => false),
      on: jest.fn().mockReturnThis(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    mockWorkers.push(worker);
    return worker;
  }),
}));
jest.mock("../strapi-instance", () => ({
  createLoadedStrapi: () => mockLoad(),
}));
jest.mock("../processors", () => ({ processMaintenanceJob: jest.fn() }));
jest.mock("../media", () => ({
  closeMediaQueues: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../snappay", () => ({
  closeSnappayQueues: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../anipo-recipient", () => ({
  closeAnipoRecipientQueues: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../anipo-registration", () => ({
  closeAnipoRegistrationQueues: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../staff-order-alert", () => ({
  closeStaffOrderAlertQueues: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/media/media-process", () => ({
  terminateActiveMediaProcesses: () => mockTerminate(),
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

import { RedisClient } from "../../index";
import { startMaintenanceWorkers } from "../worker";
import type { BackgroundProcess } from "../readiness";

describe("worker and media-worker readiness lifecycle", () => {
  const originalEnv = process.env;
  let load: ReturnType<typeof deferred<any>>;
  let runtime: BackgroundProcess | undefined;
  let app: any;
  let cache: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.WORKER_QUEUES;
    mockWorkers.length = 0;
    mockServers.length = 0;
    load = deferred<any>();
    mockLoad.mockReturnValue(load.promise);
    app = {
      db: { connection: { raw: jest.fn().mockResolvedValue([]) } },
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      destroy: jest.fn().mockResolvedValue(undefined),
    };
    cache = await RedisClient;
    cache.isReady = true;
    cache.ping.mockResolvedValue("PONG");
    runtime = undefined;
  });
  afterEach(async () => {
    await runtime?.close();
    await Promise.all(mockServers.map((server) => server.close()));
    process.env = originalEnv;
  });

  async function boot() {
    const started = startMaintenanceWorkers();
    await until(() => mockServers.length === 1);
    expect((await readStatus(mockServers[0].port)).status).toBe(503);
    load.resolve(app);
    await until(() => mockWorkers.length > 0);
    expect((await readStatus(mockServers[0].port)).status).toBe(503);
    for (const worker of mockWorkers) worker.ready.resolve(worker.blocking);
    runtime = await started;
    return mockServers[0].port;
  }

  it.each([undefined, "media"])(
    "waits for Strapi and every configured consumer (%s)",
    async (queues) => {
      if (queues) process.env.WORKER_QUEUES = queues;
      const port = await boot();
      expect(mockWorkers).toHaveLength(queues ? 1 : 4);
      expect((await readStatus(port)).status).toBe(200);
      expect(app.db.connection.raw).toHaveBeenCalledWith("SELECT 1");
      for (const worker of mockWorkers) {
        expect(worker.waitUntilReady).toHaveBeenCalledTimes(1);
        expect(worker.clientState.ping).toHaveBeenCalled();
        expect(worker.blocking.ping).not.toHaveBeenCalled();
      }
    },
  );

  it("fails when any required dependency or consumer is unavailable, and recovers", async () => {
    const port = await boot();
    expect((await readStatus(port)).status).toBe(200);
    app.db.connection.raw.mockRejectedValueOnce(new Error("database down"));
    expect((await readStatus(port)).status).toBe(503);
    cache.isReady = false;
    expect((await readStatus(port)).status).toBe(503);
    cache.isReady = true;
    mockWorkers[0].clientState.status = "reconnecting";
    expect((await readStatus(port)).status).toBe(503);
    mockWorkers[0].clientState.status = "ready";
    mockWorkers[0].blocking.status = "end";
    expect((await readStatus(port)).status).toBe(503);
    mockWorkers[0].blocking.status = "ready";
    mockWorkers[0].isRunning.mockReturnValueOnce(false);
    expect((await readStatus(port)).status).toBe(503);
    mockWorkers[0].isPaused.mockReturnValueOnce(true);
    expect((await readStatus(port)).status).toBe(503);
    expect((await readStatus(port)).status).toBe(200);
  });

  it("marks unready before draining and performs shutdown only once", async () => {
    const port = await boot();
    const drain = deferred<void>();
    mockWorkers[0].close.mockReturnValue(drain.promise);
    const closed = runtime!.close();
    expect(runtime!.close()).toBe(closed);
    expect((await readStatus(port)).status).toBe(503);
    expect(app.destroy).not.toHaveBeenCalled();
    drain.resolve();
    await closed;
    expect(mockTerminate).toHaveBeenCalledTimes(1);
    expect(app.destroy).toHaveBeenCalledTimes(1);
    for (const worker of mockWorkers)
      expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it("closes its endpoint when Strapi cannot load", async () => {
    const started = startMaintenanceWorkers();
    const rejected = expect(started).rejects.toThrow("load failed");
    await until(() => mockServers.length === 1);
    load.reject(new Error("load failed"));
    await rejected;
    expect(mockWorkers).toHaveLength(0);
    await expect(readStatus(mockServers[0].port)).rejects.toThrow();
  });

  it("drains a shutdown requested while Strapi is loading without starting consumers", async () => {
    const previous = new Set(process.listeners("SIGTERM"));
    const exit = jest
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    try {
      const started = startMaintenanceWorkers();
      await until(
        () =>
          mockServers.length === 1 &&
          process.listeners("SIGTERM").some((fn) => !previous.has(fn)),
      );
      const shutdown = process
        .listeners("SIGTERM")
        .find((fn) => !previous.has(fn))!;
      shutdown();
      expect((await readStatus(mockServers[0].port)).status).toBe(503);
      expect(exit).not.toHaveBeenCalled();
      load.resolve(app);
      runtime = await started;
      await until(() => exit.mock.calls.length > 0);
      expect(exit).toHaveBeenCalledWith(0);
      expect(mockWorkers).toHaveLength(0);
      expect(app.destroy).toHaveBeenCalledTimes(1);
    } finally {
      exit.mockRestore();
    }
  });
});
