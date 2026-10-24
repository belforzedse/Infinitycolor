jest.unmock("ioredis");

import { randomUUID } from "node:crypto";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Queue, Worker } from "bullmq";
import { closeMellatQueue, enqueueMellatAttempt } from "../../../queue/mellat";
import { getQueueSettings, toBullMqConnectionOptions } from "../../../queue/env";
import { createMaintenanceQueues } from "../../../queue/queues";
import { registerMaintenanceSchedulers } from "../../../queue/scheduler-registration";
import { MAINTENANCE_SCHEDULERS, MELLAT_PAYMENT_JOBS, QUEUE_NAMES } from "../../../queue/contracts";

let redis: StartedTestContainer;
const previous = {
  url: process.env.QUEUE_REDIS_URL,
  password: process.env.QUEUE_REDIS_PASSWORD,
  prefix: process.env.QUEUE_PREFIX,
};

beforeAll(async () => {
  redis = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  process.env.QUEUE_REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  delete process.env.QUEUE_REDIS_PASSWORD;
  process.env.QUEUE_PREFIX = `mellat-integration-${randomUUID()}`;
});

afterAll(async () => {
  await closeMellatQueue();
  await redis?.stop();
  for (const [key, value] of Object.entries({
    QUEUE_REDIS_URL: previous.url, QUEUE_REDIS_PASSWORD: previous.password, QUEUE_PREFIX: previous.prefix,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it("delivers the five-second retry even while the preceding Mellat job is active", async () => {
  const settings = getQueueSettings();
  const options = { connection: toBullMqConnectionOptions(settings), prefix: settings.prefix };
  const queue = new Queue(QUEUE_NAMES.payments, options);
  const calls: number[] = [];
  let schedulingTime: number;
  const schedule = async (delay = 0) => {
    // Reproduce two schedules in the same timestamp deterministically, while
    // retaining real Redis delivery and real five-second timer progression.
    const clock = jest.spyOn(Date, "now").mockReturnValue(schedulingTime);
    try { await enqueueMellatAttempt(812, delay); }
    finally { clock.mockRestore(); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
    timer = setTimeout(() => reject(new Error("Mellat delayed retry was not delivered")), 20_000);
  });
  const worker = new Worker(QUEUE_NAMES.payments, async (job) => {
    calls.push(Date.now());
    expect(job.name).toBe(MELLAT_PAYMENT_JOBS.reconcile);
    if (calls.length === 1) {
      expect(await job.getState()).toBe("active");
      await schedule(5_000);
      const delayed = await queue.getDelayed();
      expect(delayed).toHaveLength(1);
      expect(delayed[0].id).not.toBe(job.id);
      expect(delayed[0].delay).toBe(5_000);
    }
  }, { ...options, concurrency: 1, autorun: false });
  worker.on("failed", (_job, error) => fail(error));
  worker.on("completed", () => { if (calls.length === 2) finish(); });
  try {
    await worker.waitUntilReady();
    schedulingTime = Date.now();
    await schedule();
    void worker.run().catch(fail);
    await completed;
    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(4_500);
    expect(await queue.getCompletedCount()).toBe(2);
  } finally {
    if (timer) clearTimeout(timer);
    await worker.close();
    await queue.close();
  }
});

it("registers the durable minute sweep on the real payments queue", async () => {
  const settings = getQueueSettings();
  const queues = createMaintenanceQueues(settings);
  try {
    await registerMaintenanceSchedulers(queues, settings);
    const sweep = await queues.payments.getJobScheduler(MAINTENANCE_SCHEDULERS.mellatSweep);
    expect(sweep).toMatchObject({ name: MELLAT_PAYMENT_JOBS.sweep, every: 60_000 });
  } finally {
    await Promise.all(Object.values(queues).map(queue => queue.close()));
  }
});
