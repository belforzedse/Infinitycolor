import { ReadableStream as NodeReadableStream } from "node:stream/web";

Object.defineProperty(globalThis, "ReadableStream", {
  configurable: true,
  value: NodeReadableStream,
});

const mockStore = new Map<string, string>();
let mockOutage = false;

jest.mock("redis", () => ({
  createClient: () => {
    const client = {
      isReady: false,
      on: jest.fn(),
      connect: jest.fn(async () => {
        if (mockOutage) throw new Error("redis unavailable");
        client.isReady = true;
      }),
      get: jest.fn(async (key: string) => {
        if (mockOutage) throw new Error("redis unavailable");
        return mockStore.get(key) ?? null;
      }),
      set: jest.fn(async (key: string, value: string) => {
        if (mockOutage) throw new Error("redis unavailable");
        mockStore.set(key, value);
        return "OK";
      }),
      mGet: jest.fn(async (keys: string[]) => {
        if (mockOutage) throw new Error("redis unavailable");
        return keys.map((key) => mockStore.get(key) ?? null);
      }),
      multi: jest.fn(() => {
        const pending: Array<[string, string]> = [];
        return {
          set(key: string, value: string) {
            pending.push([key, value]);
            return this;
          },
          async exec() {
            if (mockOutage) throw new Error("redis unavailable");
            pending.forEach(([key, value]) => mockStore.set(key, value));
            return [];
          },
        };
      }),
    };
    return client;
  },
}));

type RemoteHandler = {
  get(key: string, softTags: string[]): Promise<{ value: ReadableStream<Uint8Array> } | undefined>;
  set(key: string, entry: Promise<Record<string, unknown>>): Promise<void>;
  updateTags(tags: string[], durations: { expire: number }): Promise<void>;
};

function loadHandler(release: string): RemoteHandler {
  process.env.FRONTEND_REDIS_URL = "redis://cache.test:6379";
  process.env.NEXT_CACHE_ENVIRONMENT = "test";
  process.env.CACHE_RELEASE_ID = release;
  jest.resetModules();
  return require("../../cache-handlers/redis-remote.cjs") as RemoteHandler;
}

function pendingEntry(value: string, tags: string[]) {
  return Promise.resolve({
    value: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(value));
        controller.close();
      },
    }),
    tags,
    stale: 30,
    timestamp: Date.now() - 100,
    expire: 60,
    revalidate: 30,
  });
}

async function read(entry: Awaited<ReturnType<RemoteHandler["get"]>>) {
  if (!entry) return undefined;
  const reader = entry.value.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("Cache Components Redis remote handler", () => {
  beforeEach(() => {
    mockStore.clear();
    mockOutage = false;
  });

  afterEach(() => {
    delete process.env.FRONTEND_REDIS_URL;
    delete process.env.NEXT_CACHE_ENVIRONMENT;
    delete process.env.CACHE_RELEASE_ID;
  });

  it("shares public entries between instances and invalidates them by tag", async () => {
    const first = loadHandler("release-a");
    const second = loadHandler("release-a");

    await first.set("categories", pendingEntry("shared", ["product-categories"]));
    expect(await read(await second.get("categories", []))).toBe("shared");

    await second.updateTags(["product-categories"], { expire: 3600 });
    expect(await first.get("categories", [])).toBeUndefined();
  });

  it("isolates releases and fails open during a Redis outage", async () => {
    const current = loadHandler("release-a");
    await current.set("navigation", pendingEntry("release-a", ["navigation"]));

    const nextRelease = loadHandler("release-b");
    expect(await nextRelease.get("navigation", [])).toBeUndefined();

    mockOutage = true;
    expect(await current.get("navigation", [])).toBeUndefined();
    await expect(current.set("navigation", pendingEntry("ignored", []))).resolves.toBeUndefined();
  });
});
