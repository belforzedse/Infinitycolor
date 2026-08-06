/**
 * Redis-backed cache handler for Next.js ISR/Data Cache.
 * Uses @fortedigital/nextjs-cache-handler (Next.js 16–compatible) with redis-strings.
 * Shares cache across all Next.js storefront instances.
 *
 * Architecture:
 * - Redis: shared across instances when FRONTEND_REDIS_URL is set
 * - Build fallback: local LRU only while Next.js is producing an image
 * - Runtime failure: no-op cache, so public reads fail open to the origin
 *
 * Build-safe: Works without Redis during Docker build (FRONTEND_REDIS_URL unset).
 * Uses global cache for handler config so only one Redis connection is created per process.
 */

import { CacheHandler } from '@fortedigital/nextjs-cache-handler';
import createRedisHandler from '@fortedigital/nextjs-cache-handler/redis-strings';
import createLruHandler from '@fortedigital/nextjs-cache-handler/local-lru';
import { createClient } from 'redis';

const LRU_OPTIONS = {
  maxItemSizeBytes: 256 * 1024 * 1024, // 256MB max per item
  maxItemsNumber: 10000,
};

const NOOP_HANDLER = {
  name: 'origin-fallback',
  async get() {
    return null;
  },
  async set() {},
  async revalidateTag() {},
  async delete() {},
};

const safeNamespacePart = (value, fallback) => {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
};

export const getCacheKeyPrefix = () => {
  const environment = safeNamespacePart(
    process.env.NEXT_CACHE_ENVIRONMENT,
    process.env.NODE_ENV === 'production' ? 'production' : 'development',
  );
  const release = safeNamespacePart(
    process.env.NEXT_CACHE_RELEASE || process.env.NEXT_PUBLIC_BUILD_VERSION,
    'local',
  );
  return `infinity:${environment}:storefront:${release}:incremental:v1:`;
};

function createLruOnlyConfig() {
  return {
    handlers: [
      createLruHandler(LRU_OPTIONS),
    ],
  };
}

function createOriginFallbackConfig() {
  return { handlers: [NOOP_HANDLER] };
}

CacheHandler.onCreation(async () => {
  // Reuse existing config so we create only one Redis connection per process
  // (Next.js may call onCreation multiple times in some setups)
  if (global.cacheHandlerConfig) {
    return global.cacheHandlerConfig;
  }
  if (global.cacheHandlerConfigPromise) {
    return global.cacheHandlerConfigPromise;
  }

  const redisUrl = process.env.FRONTEND_REDIS_URL?.trim();

  if (!redisUrl) {
    const isBuild = process.env.NEXT_PHASE === 'phase-production-build';
    console.info(
      `[CacheHandler] FRONTEND_REDIS_URL not set, using ${isBuild ? 'build LRU' : 'origin fallback'}`,
    );
    global.cacheHandlerConfig = isBuild ? createLruOnlyConfig() : createOriginFallbackConfig();
    return global.cacheHandlerConfig;
  }

  let client;
  try {
    client = createClient({
      url: redisUrl,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 1000,
        // A cache outage must not hold storefront requests in a reconnect loop.
        // The next deployment/restart reconnects after the dependency recovers.
        reconnectStrategy: false,
      },
    });
    client.on('error', (err) => {
      if (typeof process.env.NEXT_PRIVATE_DEBUG_CACHE !== 'undefined') {
        console.error('[CacheHandler] Redis client error:', err);
      }
      global.cacheHandlerConfig = null;
      global.cacheHandlerConfigPromise = null;
    });
  } catch (error) {
    console.warn('[CacheHandler] Failed to create Redis client:', error?.message ?? error);
    global.cacheHandlerConfig = createOriginFallbackConfig();
    return global.cacheHandlerConfig;
  }

  const init = async () => {
    try {
      console.info('[CacheHandler] Connecting Redis client...');
      await client.connect();
      console.info('[CacheHandler] Redis client connected.');
    } catch (error) {
      console.warn('[CacheHandler] Failed to connect Redis client:', error?.message ?? error);
      try {
        client.destroy();
      } catch {
        // Ignore shutdown errors
      }
      const config = createOriginFallbackConfig();
      console.warn('[CacheHandler] Redis unavailable; falling back to uncached origin reads');
      global.cacheHandlerConfig = config;
      global.cacheHandlerConfigPromise = null;
      return config;
    }

    if (!client?.isReady) {
      const config = createOriginFallbackConfig();
      global.cacheHandlerConfig = config;
      global.cacheHandlerConfigPromise = null;
      return config;
    }

    const handler = await createRedisHandler({
      client,
      keyPrefix: getCacheKeyPrefix(),
      timeoutMs: 1000,
    });
    console.info('[CacheHandler] Using redis-strings handler with shared Redis');
    const config = { handlers: [handler] };
    global.cacheHandlerConfig = config;
    global.cacheHandlerConfigPromise = null;
    return config;
  };

  global.cacheHandlerConfigPromise = init();
  return global.cacheHandlerConfigPromise;
});

export default CacheHandler;
