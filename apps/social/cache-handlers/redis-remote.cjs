const { createHash } = require("node:crypto");
const { createClient } = require("redis");

const commandTimeoutMs = 1_000;
const maxEntryBytes = 4 * 1024 * 1024;
const environment = process.env.NEXT_CACHE_ENVIRONMENT || process.env.NODE_ENV || "development";
const release =
  process.env.CACHE_RELEASE_ID || process.env.NEXT_CACHE_RELEASE || process.env.CI_COMMIT_SHA || "local";
const namespace = `infinity:social:next-cache:${environment}:${release}:remote:v1`;
const pendingSets = new Map();
let client;
let connecting;

const digest = (value) => createHash("sha256").update(value).digest("base64url");
const entryKey = (cacheKey) => `${namespace}:entry:${digest(cacheKey)}`;
const tagKey = (tag) => `${namespace}:tag:${digest(tag)}`;

async function withTimeout(operation) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("redis_cache_timeout")), commandTimeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function redis() {
  const url = (process.env.SOCIAL_REDIS_URL || process.env.FRONTEND_REDIS_URL)?.trim();
  if (!url) return undefined;
  if (client?.isReady) return client;
  if (!client) {
    client = createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: commandTimeoutMs, reconnectStrategy: false },
    });
    client.on("error", () => undefined);
  }
  connecting ??= withTimeout(client.connect()).catch(() => undefined);
  await connecting;
  connecting = undefined;
  return client.isReady ? client : undefined;
}

async function invalidatedAfter(tags, timestamp) {
  if (!tags.length) return false;
  const connection = await redis();
  if (!connection) return false;
  const values = await withTimeout(connection.mGet(tags.map(tagKey)));
  return values.some((value) => Number(value || 0) > timestamp);
}

module.exports = {
  async get(cacheKey, softTags) {
    try {
      const pending = pendingSets.get(cacheKey);
      if (pending) await pending;
      const connection = await redis();
      if (!connection) return undefined;
      const stored = await withTimeout(connection.get(entryKey(cacheKey)));
      if (!stored) return undefined;
      const entry = JSON.parse(stored);
      if (
        Date.now() > entry.timestamp + entry.expire * 1_000 ||
        (await invalidatedAfter([...entry.tags, ...softTags], entry.timestamp))
      ) return undefined;
      const value = Buffer.from(entry.value, "base64");
      return {
        ...entry,
        value: new ReadableStream({
          start(controller) {
            controller.enqueue(value);
            controller.close();
          },
        }),
      };
    } catch {
      return undefined;
    }
  },

  async set(cacheKey, pendingEntry) {
    const write = (async () => {
      try {
        const entry = await pendingEntry;
        const reader = entry.value.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxEntryBytes) return;
            chunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
        const connection = await redis();
        if (!connection) return;
        await withTimeout(
          connection.set(
            entryKey(cacheKey),
            JSON.stringify({
              value: Buffer.concat(chunks).toString("base64"),
              tags: entry.tags,
              stale: entry.stale,
              timestamp: entry.timestamp,
              expire: entry.expire,
              revalidate: entry.revalidate,
            }),
            { EX: Math.max(1, Math.min(86_400, Math.ceil(entry.expire))) },
          ),
        );
      } catch {
        // Cache outages fail open to the origin.
      }
    })();
    pendingSets.set(cacheKey, write);
    try {
      await write;
    } finally {
      pendingSets.delete(cacheKey);
    }
  },

  async refreshTags() {},
  async getExpiration(tags) {
    try {
      if (!tags.length) return 0;
      const connection = await redis();
      if (!connection) return 0;
      const values = await withTimeout(connection.mGet(tags.map(tagKey)));
      return Math.max(0, ...values.map((value) => Number(value || 0)));
    } catch {
      return 0;
    }
  },
  async updateTags(tags, durations) {
    try {
      const connection = await redis();
      if (!connection || !tags.length) return;
      const timestamp = String(Date.now());
      const ttl = Math.max(86_400, Math.min(2_592_000, Math.ceil(durations?.expire || 2_592_000)));
      const transaction = connection.multi();
      for (const tag of tags) transaction.set(tagKey(tag), timestamp, { EX: ttl });
      await withTimeout(transaction.exec());
    } catch {
      // Cache outages fail open.
    }
  },
};
