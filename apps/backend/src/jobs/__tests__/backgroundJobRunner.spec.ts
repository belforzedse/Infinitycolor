import {
  __resetBackgroundJobGuardsForTests,
  runBackgroundJob,
} from "../backgroundJobRunner";

const strapi = {
  log: { info: jest.fn(), error: jest.fn() },
} as any;

beforeEach(() => {
  jest.clearAllMocks();
  __resetBackgroundJobGuardsForTests();
});

it("rejects processor failures so BullMQ can retry them", async () => {
  const failure = new Error("database unavailable");
  await expect(
    runBackgroundJob({
      strapi,
      jobName: "retryable",
      run: jest.fn().mockRejectedValue(failure),
    }),
  ).rejects.toBe(failure);
  expect(strapi.log.error).toHaveBeenCalledWith(
    expect.stringContaining("database unavailable"),
    expect.any(Object),
  );
});

it("releases the in-process guard after a failure", async () => {
  await expect(
    runBackgroundJob({
      strapi,
      jobName: "guarded",
      run: jest.fn().mockRejectedValue(new Error("first failure")),
    }),
  ).rejects.toThrow("first failure");

  await expect(
    runBackgroundJob({
      strapi,
      jobName: "guarded",
      run: jest.fn().mockResolvedValue({ processed: 1 }),
    }),
  ).resolves.toMatchObject({ status: "completed", stats: { processed: 1 } });
});

it("keeps concurrent in-process skips as completed control flow", async () => {
  let resolveRun!: (value: any) => void;
  const pending = new Promise((resolve) => {
    resolveRun = resolve;
  });
  const first = runBackgroundJob({
    strapi,
    jobName: "same-job",
    run: () => pending,
  });
  await expect(
    runBackgroundJob({
      strapi,
      jobName: "same-job",
      run: jest.fn(),
    }),
  ).resolves.toMatchObject({ status: "skipped", skippedReason: "in_process" });
  resolveRun({ processed: 1 });
  await first;
});
