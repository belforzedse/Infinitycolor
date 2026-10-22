import {
  startBackgroundReadiness,
  redisResponds,
  type BackgroundReadiness,
} from "../readiness";
import { deferred, readStatus } from "../../__tests__/readiness-http";

describe("background readiness endpoint", () => {
  const servers: BackgroundReadiness[] = [];
  const start = async (probe: () => Promise<boolean>, timeoutMs = 100) => {
    const server = await startBackgroundReadiness(probe, {
      port: 0,
      timeoutMs,
    });
    servers.push(server);
    return server;
  };
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("fails before initialization, checks live dependencies, and supports HEAD probes", async () => {
    const probe = jest.fn().mockResolvedValue(true);
    const server = await start(probe);
    expect(await readStatus(server.port)).toEqual({
      status: 503,
      body: '{"ok":false}',
    });
    expect(probe).not.toHaveBeenCalled();
    server.markReady();
    expect(await readStatus(server.port, "HEAD")).toEqual({
      status: 200,
      body: "",
    });
    probe.mockResolvedValueOnce(false);
    expect((await readStatus(server.port)).status).toBe(503);
    expect((await readStatus(server.port)).status).toBe(200);
    server.markUnready();
    expect((await readStatus(server.port)).status).toBe(503);
    expect((await readStatus(server.port, "GET", "/other")).status).toBe(404);
  });

  it("bounds a hung dependency and shares it across subsequent probes", async () => {
    let release!: (value: boolean) => void;
    const probe = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const server = await start(probe, 20);
    server.markReady();
    expect((await readStatus(server.port)).status).toBe(503);
    expect((await readStatus(server.port)).status).toBe(503);
    expect(probe).toHaveBeenCalledTimes(1);
    release(true);
    await new Promise(setImmediate);
    probe.mockResolvedValue(true);
    expect((await readStatus(server.port)).status).toBe(200);
  });

  it("does not expose dependency failures", async () => {
    const server = await start(async () => {
      throw new Error("private connection detail");
    });
    server.markReady();
    expect(await readStatus(server.port)).toEqual({
      status: 503,
      body: '{"ok":false}',
    });
  });

  it("cannot become ready again while closing, including a probe already in flight", async () => {
    const started = deferred<void>();
    const probe = deferred<boolean>();
    const server = await start(() => {
      started.resolve();
      return probe.promise;
    });
    server.markReady();
    const response = readStatus(server.port);
    await started.promise;
    const closing = server.close();
    server.markReady();
    probe.resolve(true);
    expect((await response).status).toBe(503);
    await closing;
  });

  it("requires a ready Redis connection and a PONG response", async () => {
    const client = {
      status: "reconnecting",
      ping: jest.fn().mockResolvedValue("PONG"),
    };
    expect(await redisResponds(client)).toBe(false);
    expect(client.ping).not.toHaveBeenCalled();
    client.status = "ready";
    expect(await redisResponds(client)).toBe(true);
    client.ping.mockResolvedValue("not-pong");
    expect(await redisResponds(client)).toBe(false);
  });

  it("uses INFO for BullMQ adapters whose public client contract has no PING", async () => {
    const client = {
      status: "ready",
      info: jest.fn().mockResolvedValue("# Server\r\nredis_version:7.4.0"),
    };
    expect(await redisResponds(client)).toBe(true);
    client.info.mockResolvedValue("");
    expect(await redisResponds(client)).toBe(false);
  });
});
