import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { getQueueSettings, toBullMqConnectionOptions } from "../env";
import { createMaintenanceQueues } from "../queues";
import { registerMaintenanceSchedulers } from "../scheduler-registration";
import {
  redisConnectionReady,
  redisResponds,
  startBackgroundReadiness,
} from "../readiness";
import { readStatus } from "../../__tests__/readiness-http";

const describeRedis = process.env.QUEUE_TEST_REDIS_URL
  ? describe
  : describe.skip;

describeRedis("background readiness with isolated Redis", () => {
  const settings = getQueueSettings({
    QUEUE_REDIS_URL: process.env.QUEUE_TEST_REDIS_URL,
    QUEUE_PREFIX: `readiness-test-${randomUUID()}`,
  });
  let oldQueues: ReturnType<typeof createMaintenanceQueues>;
  let newQueues: ReturnType<typeof createMaintenanceQueues>;

  beforeAll(() => {
    const target = new URL(settings.redisUrl);
    if (target.hostname !== "127.0.0.1" || target.username || target.password) {
      throw new Error(
        "QUEUE_TEST_REDIS_URL must point to the owned loopback Redis fixture",
      );
    }
    oldQueues = createMaintenanceQueues(settings);
    newQueues = createMaintenanceQueues(settings);
    for (const queue of [
      ...Object.values(oldQueues),
      ...Object.values(newQueues),
    ]) {
      queue.on("error", () => undefined);
    }
  });
  afterAll(async () => {
    if (!oldQueues || !newQueues) return;
    try {
      await Promise.all(
        Object.values(oldQueues).map((queue) =>
          queue.obliterate({ force: true }),
        ),
      );
    } finally {
      await Promise.all(
        [...Object.values(oldQueues), ...Object.values(newQueues)].map(
          (queue) => queue.close(),
        ),
      );
    }
  });

  it("keeps one schedule and one pending job per fixed ID during overlapping registration", async () => {
    await Promise.all([
      registerMaintenanceSchedulers(oldQueues, settings),
      registerMaintenanceSchedulers(newQueues, settings),
    ]);
    // Reasserting while both processes are still present must remain idempotent.
    await Promise.all([
      registerMaintenanceSchedulers(newQueues, settings),
      registerMaintenanceSchedulers(oldQueues, settings),
    ]);
    for (const [name, count] of [
      ["commerce", 6],
      ["analytics", 3],
      ["payments", 2],
    ] as const) {
      const oldSchedules = await oldQueues[name].getJobSchedulers();
      const newSchedules = await newQueues[name].getJobSchedulers();
      expect(oldSchedules).toHaveLength(count);
      expect(newSchedules).toEqual(oldSchedules);
      expect(new Set(oldSchedules.map((schedule) => schedule.key)).size).toBe(
        count,
      );
      expect(await oldQueues[name].getDelayedCount()).toBe(count);
    }
  });

  it("checks an idle real BullMQ consumer without pinging its blocking connection", async () => {
    const queue = new Queue("readiness-consumer", {
      connection: toBullMqConnectionOptions(settings),
      prefix: settings.prefix,
    });
    const worker = new Worker(queue.name, async () => undefined, {
      connection: toBullMqConnectionOptions(settings),
      prefix: settings.prefix,
    });
    worker.on("error", () => undefined);
    const blocking = await worker.waitUntilReady();
    const endpoint = await startBackgroundReadiness(
      async () => {
        return (
          !worker.closing &&
          worker.isRunning() &&
          !worker.isPaused() &&
          redisConnectionReady(blocking) &&
          redisResponds(await worker.client)
        );
      },
      { port: 0, timeoutMs: 1500 },
    );
    try {
      expect((await readStatus(endpoint.port)).status).toBe(503);
      endpoint.markReady();
      expect((await readStatus(endpoint.port)).status).toBe(200);
      await worker.pause();
      expect((await readStatus(endpoint.port)).status).toBe(503);
      worker.resume();
      expect((await readStatus(endpoint.port)).status).toBe(200);
      await worker.close();
      expect((await readStatus(endpoint.port)).status).toBe(503);
    } finally {
      await worker.close();
      await endpoint.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
