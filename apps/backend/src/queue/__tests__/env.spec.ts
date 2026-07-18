import { getQueueSettings, toBullMqConnectionOptions } from "../env";

describe("queue env", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("uses safe defaults for recurring maintenance jobs", () => {
    delete process.env.QUEUE_REDIS_URL;
    delete process.env.QUEUE_REDIS_PASSWORD;
    delete process.env.QUEUE_PREFIX;
    delete process.env.WORKER_CONCURRENCY_COMMERCE;

    const settings = getQueueSettings();

    expect(settings.redisUrl).toBe("redis://localhost:6379");
    expect(settings.prefix).toBe("bull:infinity");
    expect(settings.timezone).toBe("Asia/Tehran");
    expect(settings.concurrency.commerce).toBe(1);
    expect(settings.concurrency.analytics).toBe(1);
    expect(settings.crons.stockReservationExpiry).toBe("*/1 * * * *");
    expect(settings.crons.reserveOrderExpiry).toBe("*/5 * * * *");
    expect(settings.crons.viewCounterFlush).toBe("*/1 * * * *");
  });

  it("parses queue Redis URL into BullMQ/ioredis connection options", () => {
    process.env.QUEUE_REDIS_URL = "redis://:url-secret@queue-redis:6380/2";
    process.env.QUEUE_REDIS_PASSWORD = "env-secret";

    const connection = toBullMqConnectionOptions(getQueueSettings());

    expect(connection).toEqual({
      host: "queue-redis",
      port: 6380,
      db: 2,
      password: "env-secret",
      maxRetriesPerRequest: null,
    });
  });
});
