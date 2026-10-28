import type { Server } from "node:http";

/**
 * Drain in-flight requests on SIGTERM instead of cutting them.
 *
 * Strapi 4.25 registers `terminateStrapi` for SIGTERM and SIGINT. It calls
 * `strapi.destroy()`, whose HTTP server `destroy` first destroys every open
 * socket, so a request still in progress when a rolling update stops the old
 * task gets a reset. Next.js 16 already drains on SIGTERM (`server.close()`),
 * and this does the same for the web role with Node's own server API:
 * stop accepting connections, close idle keep-alive sockets, let the active
 * requests finish, then run Strapi's normal teardown. Sockets still open
 * after `timeoutMs` are closed, so the process exits inside the container's
 * stop grace period.
 */

type DrainableServer = Pick<Server, "close" | "closeIdleConnections" | "closeAllConnections">;

type SignalTarget = {
  listeners(event: "SIGTERM" | "SIGINT"): Function[];
  removeListener(event: "SIGTERM" | "SIGINT", listener: (...args: any[]) => void): unknown;
  once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
};

type ShutdownLogger = {
  info(message: string): void;
  warn(message: string): void;
};

export type GracefulShutdownOptions = {
  server: DrainableServer;
  destroy: () => Promise<void>;
  log: ShutdownLogger;
  timeoutMs: number;
  signals?: SignalTarget;
  exit?: (code: number) => void;
};

const SIGNALS = ["SIGTERM", "SIGINT"] as const;
// The name of the listener Strapi's `destroyOnSignal` installs
// (@strapi/strapi/dist/utils/signals.js).
const STRAPI_SIGNAL_LISTENER = "terminateStrapi";

/**
 * Replaces Strapi's signal listeners with the drain. Returns false (and
 * changes nothing) when Strapi's listeners are not where 4.25 puts them, so an
 * upgrade that changes them keeps Strapi's own behaviour rather than two
 * competing handlers.
 */
export function installGracefulShutdown({
  server,
  destroy,
  log,
  timeoutMs,
  signals = process,
  exit = (code) => process.exit(code),
}: GracefulShutdownOptions): boolean {
  const strapiListeners = SIGNALS.map((signal) => ({
    signal,
    listener: signals.listeners(signal).find((fn) => fn.name === STRAPI_SIGNAL_LISTENER),
  }));
  if (strapiListeners.some(({ listener }) => !listener)) {
    log.warn("Strapi's signal listeners were not found; keeping Strapi's own shutdown.");
    return false;
  }
  for (const { signal, listener } of strapiListeners) {
    signals.removeListener(signal, listener as (...args: any[]) => void);
  }

  let started = false;
  const drain = async (signal: string) => {
    if (started) return;
    started = true;
    log.info(`${signal} received: draining in-flight requests (up to ${timeoutMs} ms)`);
    const forceClose = setTimeout(() => {
      log.warn(`Requests still open after ${timeoutMs} ms; closing them.`);
      server.closeAllConnections();
    }, timeoutMs);
    forceClose.unref?.();
    // A keep-alive socket that finishes its last request after close() stays
    // open until something closes it, so sweep idle sockets while draining.
    const idleSweep = setInterval(() => server.closeIdleConnections(), 500);
    idleSweep.unref?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    clearInterval(idleSweep);
    clearTimeout(forceClose);
    try {
      await destroy();
    } finally {
      exit(0);
    }
  };
  for (const signal of SIGNALS) {
    signals.once(signal, () => void drain(signal));
  }
  return true;
}
