/**
 * Every media producer's job options go through BullMQ's own `Job#validateOptions` — the
 * check `Queue.add` runs before touching Redis. A string-shape assertion is not enough:
 * the ":"-separated ids passed a mocked `add` for weeks while BullMQ rejected every real
 * one with "Custom Id cannot contain :", so no transcode was ever queued in production.
 */
const added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];

jest.mock("bullmq", () => {
  const actual = jest.requireActual("bullmq");
  return {
    ...actual,
    Queue: jest.fn().mockImplementation(() => ({
      add: jest.fn(async (name: string, data: unknown, opts: Record<string, unknown>) => {
        added.push({ name, data, opts });
      }),
      close: jest.fn(async () => undefined),
    })),
  };
});

import { Job } from "bullmq";
import {
  closeMediaQueues,
  enqueueProductVideoNormalization,
  enqueueStoryVideoNormalization,
  enqueueUploadedFileNormalization,
  enqueueVideoProcessingFor,
  mediaJobId,
} from "../media";

const settings = {
  redisUrl: "redis://localhost:6379",
  prefix: "bull:test",
  timezone: "Asia/Tehran",
  queues: [],
  concurrency: { commerce: 1, analytics: 1, payments: 1, media: 1 },
  crons: {},
} as any;

function validateWithBullmq(entry: (typeof added)[number]): void {
  const validate = (Job.prototype as any).validateOptions as (jobData: { data: string }) => void;
  validate.call({ name: entry.name, opts: entry.opts }, { data: JSON.stringify(entry.data) });
}

describe("media queue job ids", () => {
  beforeEach(() => {
    added.length = 0;
  });

  afterAll(async () => {
    await closeMediaQueues();
  });

  it("every producer's options pass BullMQ's own validation", async () => {
    await enqueueStoryVideoNormalization(34, "legacy:34", 112911, settings);
    await enqueueStoryVideoNormalization(34, "item-with:colon", 112912, settings);
    await enqueueProductVideoNormalization(4624, 120001, settings);
    await enqueueUploadedFileNormalization(112911, settings);
    await enqueueVideoProcessingFor(112911, "post-77", settings);
    await enqueueVideoProcessingFor(112911, "weird:context/with spaces", settings);

    expect(added).toHaveLength(6);
    for (const entry of added) {
      expect(() => validateWithBullmq(entry)).not.toThrow();
      expect(String(entry.opts.jobId)).not.toContain(":");
    }
  });

  it("the validation this test relies on really rejects the old ids", () => {
    for (const jobId of ["normalize-product-video:120001", "normalize-story-video:34:abc:112911", "112911"]) {
      expect(() => validateWithBullmq({ name: "x", data: {}, opts: { jobId } })).toThrow(/Custom Id/);
    }
  });

  it("keeps ids stable so repeated saves still collapse into one job", async () => {
    await enqueueStoryVideoNormalization(34, "a", 5, settings);
    await enqueueStoryVideoNormalization(34, "a", 5, settings);
    await enqueueStoryVideoNormalization(34, "b", 5, settings);
    const [first, second, third] = added.map((entry) => entry.opts.jobId);
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(mediaJobId("normalize-uploaded-file", 9)).toBe("normalize-uploaded-file-9");
  });
});
