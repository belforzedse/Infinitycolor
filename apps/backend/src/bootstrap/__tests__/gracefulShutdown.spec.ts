import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { installGracefulShutdown } from "../gracefulShutdown";

const silentLog = { info: jest.fn(), warn: jest.fn() };

// Strapi's own listener, as @strapi/strapi/dist/utils/signals.js names it.
const withStrapiListeners = (onSignal: () => void) => {
  const signals = new EventEmitter();
  const terminateStrapi = () => onSignal();
  signals.on("SIGTERM", terminateStrapi);
  signals.on("SIGINT", terminateStrapi);
  return signals;
};

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

const get = (port: number, path: string, agent: http.Agent) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, agent }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });

describe("installGracefulShutdown", () => {
  it("lets a request in flight at SIGTERM finish, then destroys Strapi and exits 0", async () => {
    let finishSlowRequest: () => void = () => undefined;
    const server = http.createServer((req, res) => {
      if (req.url === "/slow") {
        finishSlowRequest = () => res.end("done");
        return;
      }
      res.end("ok");
    });
    const port = await listen(server);
    const agent = new http.Agent({ keepAlive: true });
    // An idle keep-alive socket, like nginx's upstream pool holds.
    await get(port, "/fast", agent);

    const strapiTerminate = jest.fn();
    const signals = withStrapiListeners(strapiTerminate);
    const destroy = jest.fn(async () => undefined);
    const exited = new Promise<number>((resolve) => {
      const installed = installGracefulShutdown({
        server,
        destroy,
        log: silentLog,
        timeoutMs: 5_000,
        signals,
        exit: resolve,
      });
      expect(installed).toBe(true);
    });

    const inFlight = get(port, "/slow", new http.Agent({ keepAlive: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    signals.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(strapiTerminate).not.toHaveBeenCalled();
    expect(server.listening).toBe(false);
    expect(destroy).not.toHaveBeenCalled();

    finishSlowRequest();
    await expect(inFlight).resolves.toEqual({ status: 200, body: "done" });
    await expect(exited).resolves.toBe(0);
    expect(destroy).toHaveBeenCalledTimes(1);
    agent.destroy();
  });

  it("closes connections still open after the timeout so the process always exits", async () => {
    const server = http.createServer(() => undefined); // never answers
    const port = await listen(server);
    const signals = withStrapiListeners(jest.fn());
    const destroy = jest.fn(async () => undefined);
    const exited = new Promise<number>((resolve) => {
      installGracefulShutdown({ server, destroy, log: silentLog, timeoutMs: 100, signals, exit: resolve });
    });

    const stuck = get(port, "/hang", new http.Agent({ keepAlive: true })).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    signals.emit("SIGTERM");

    await expect(exited).resolves.toBe(0);
    // The stuck request is reset rather than keeping the process alive.
    expect(await stuck).toMatchObject({ code: "ECONNRESET" });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("changes nothing when Strapi's listeners are not the ones it expects", () => {
    const signals = new EventEmitter();
    const somethingElse = jest.fn();
    signals.on("SIGTERM", somethingElse);
    const server = http.createServer();

    const installed = installGracefulShutdown({
      server,
      destroy: jest.fn(),
      log: silentLog,
      timeoutMs: 100,
      signals,
      exit: jest.fn(),
    });

    expect(installed).toBe(false);
    expect(signals.listeners("SIGTERM")).toEqual([somethingElse]);
  });

  it("drains once when SIGTERM and SIGINT both arrive", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await listen(server);
    const signals = withStrapiListeners(jest.fn());
    const destroy = jest.fn(async () => undefined);
    const exit = jest.fn();
    installGracefulShutdown({ server, destroy, log: silentLog, timeoutMs: 1_000, signals, exit });

    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
