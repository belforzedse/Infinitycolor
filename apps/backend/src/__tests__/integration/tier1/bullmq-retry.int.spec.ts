jest.unmock("ioredis");

import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Queue, QueueEvents, UnrecoverableError, Worker } from "bullmq";
import {
  __resetBackgroundJobGuardsForTests,
  runBackgroundJob,
} from "../../../jobs/backgroundJobRunner";

let redis: StartedTestContainer;
let queue: Queue;
let events: QueueEvents;
let connection: { host: string; port: number; maxRetriesPerRequest: null };

const strapi = {
  log: { info: jest.fn(), error: jest.fn() },
} as any;

beforeAll(async () => {
  redis = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  connection = {
    host: redis.getHost(),
    port: redis.getMappedPort(6379),
    maxRetriesPerRequest: null,
  };
  queue = new Queue(`commerce-integrity-${Date.now()}`, { connection });
  events = new QueueEvents(queue.name, { connection });
  await events.waitUntilReady();
});

afterAll(async () => {
  await events?.close();
  await queue?.close();
  await redis?.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  __resetBackgroundJobGuardsForTests();
  await queue.drain(true);
});

it("emits a failed event, applies backoff, releases the guard, and succeeds on retry", async () => {
  const attempts: number[] = [];
  const failedEvents: Array<{ jobId?: string; message: string }> = [];
  const worker = new Worker(
    queue.name,
    async () => {
      attempts.push(Date.now());
      return runBackgroundJob({
        strapi,
        jobName: "bullmq-fail-then-succeed",
        run: async () => {
          if (attempts.length === 1) throw new Error("retry me");
          return { processed: 1 };
        },
      });
    },
    { connection },
  );
  worker.on("failed", (failedJob, error) => {
    failedEvents.push({ jobId: failedJob?.id, message: error.message });
  });

  try {
    const job = await queue.add(
      "fail-then-succeed",
      {},
      { attempts: 2, backoff: { type: "fixed", delay: 100 } },
    );
    await expect(job.waitUntilFinished(events, 10_000)).resolves.toMatchObject({
      status: "completed",
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(75);
    expect(failedEvents).toContainEqual({ jobId: job.id, message: "retry me" });
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(2);
  } finally {
    await worker.close();
  }
});

it("ends in failed state after attempts are exhausted", async () => {
  let calls = 0;
  const failedEvents: Array<{ jobId?: string; message: string }> = [];
  const worker = new Worker(
    queue.name,
    async () => {
      calls += 1;
      return runBackgroundJob({
        strapi,
        jobName: "bullmq-exhausted",
        run: async () => {
          throw new Error("permanent database outage");
        },
      });
    },
    { connection },
  );
  worker.on("failed", (failedJob, error) => {
    failedEvents.push({ jobId: failedJob?.id, message: error.message });
  });

  try {
    const job = await queue.add("exhausted", {}, { attempts: 2, backoff: 25 });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(
      "permanent database outage",
    );
    const persisted = await queue.getJob(job.id!);
    expect(calls).toBe(2);
    expect(persisted?.attemptsMade).toBe(2);
    expect(await persisted?.getState()).toBe("failed");
    expect(failedEvents.filter((event) => event.jobId === job.id)).toHaveLength(2);
  } finally {
    await worker.close();
  }
});

it("does not retry permanent BullMQ input errors", async () => {
  let calls = 0;
  const worker = new Worker(
    queue.name,
    async () => {
      calls += 1;
      throw new UnrecoverableError("invalid permanent input");
    },
    { connection },
  );
  try {
    const job = await queue.add("unrecoverable", {}, { attempts: 5, backoff: 25 });

    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(
      "invalid permanent input",
    );
    expect(calls).toBe(1);
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(1);
  } finally {
    await worker.close();
  }
});
