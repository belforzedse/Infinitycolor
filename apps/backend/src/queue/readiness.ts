import { createServer } from "node:http";

export type ReadinessRedisClient = {
  status?: string;
  isReady?: boolean;
  ping?: () => Promise<unknown>;
  info?: () => Promise<string>;
};

export type BackgroundReadiness = {
  port: number;
  markReady: () => void;
  markUnready: () => void;
  close: () => Promise<void>;
};

export type BackgroundProcess = { close: () => Promise<void> };

/** The blocking worker client must not be pinged: its command may be waiting for a job. */
export function redisConnectionReady(client: ReadinessRedisClient): boolean {
  return typeof client.status === "string"
    ? client.status === "ready"
    : client.isReady === true;
}

export async function redisResponds(
  client: ReadinessRedisClient,
): Promise<boolean> {
  if (!redisConnectionReady(client)) return false;
  if (client.ping) return (await client.ping()) === "PONG";
  // BullMQ's public IRedisClient contract guarantees INFO, while PING is an
  // additional method exposed by the current ioredis adapter's proxy.
  return Boolean(client.info && (await client.info()));
}

/** Each container gets a private loopback endpoint; no application port is published. */
export async function startBackgroundReadiness(
  probe: () => Promise<boolean>,
  { port = 1338, timeoutMs = 1500 }: { port?: number; timeoutMs?: number } = {},
): Promise<BackgroundReadiness> {
  let enabled = false;
  let closing: Promise<void> | undefined;
  let checking: Promise<boolean> | undefined;

  const check = async (): Promise<boolean> => {
    if (!enabled || closing) return false;
    // A stalled dependency cannot accumulate probes from concurrent health checks.
    if (!checking) {
      checking = Promise.resolve()
        .then(probe)
        .catch(() => false)
        .finally(() => {
          checking = undefined;
        });
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const ok = await Promise.race([
        checking,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      return enabled && !closing && ok;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const server = createServer(async (request, response) => {
    if (
      request.url !== "/ready" ||
      !["GET", "HEAD"].includes(request.method || "")
    ) {
      response.writeHead(404).end();
      return;
    }
    const ok = await check();
    response.writeHead(ok ? 200 : 503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(
      request.method === "HEAD" ? undefined : JSON.stringify({ ok }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Readiness server did not bind");

  return {
    port: address.port,
    markReady: () => {
      if (!closing) enabled = true;
    },
    markUnready: () => {
      enabled = false;
    },
    close: () => {
      enabled = false;
      if (!closing) {
        closing = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        });
      }
      return closing;
    },
  };
}
