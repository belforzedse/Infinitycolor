import * as Sentry from "@sentry/node";
jest.mock("@sentry/node", () => ({ logger: { info: jest.fn() }, isEnabled: jest.fn(() => true) }));

const base = {
  SENTRY_ENVIRONMENT: "staging",
  SENTRY_DIAGNOSTICS_PROBE_ID: "verification_20261001",
};
let emit: typeof import("../sentry-staging-probe").emitStagingStartupProbe;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(Sentry.isEnabled).mockReturnValue(true);
  jest.isolateModules(() => {
    emit = require("../sentry-staging-probe").emitStagingStartupProbe;
  });
});

it.each([
  ["web", undefined, "api"],
  ["worker", undefined, "worker"],
  ["worker", "media", "media-worker"],
  ["scheduler", undefined, "scheduler"],
])("labels %s/%s without exposing queue credentials", (role, queues, area) => {
  expect(emit({ ...base, PROCESS_ROLE: role, WORKER_QUEUES: queues })).toBe(true);
  expect(emit({ ...base, PROCESS_ROLE: role, WORKER_QUEUES: queues })).toBe(false);
  expect(Sentry.logger.info).toHaveBeenCalledTimes(1);
  expect(Sentry.logger.info).toHaveBeenCalledWith("diagnostics.probe", {
    area,
    stage: "startup",
    reasonCode: base.SENTRY_DIAGNOSTICS_PROBE_ID,
    diagnostic_event: "diagnostics.probe",
  });
});

it.each([
  { ...base, SENTRY_ENVIRONMENT: "production" },
  { ...base, SENTRY_DIAGNOSTICS_PROBE_ID: "" },
  { ...base, SENTRY_DIAGNOSTICS_PROBE_ID: "https://private.test/token" },
  { ...base, PROCESS_ROLE: "cli" },
])("does not emit for production, disabled, invalid, or CLI contexts", (env) => {
  expect(emit(env)).toBe(false);
  expect(Sentry.logger.info).not.toHaveBeenCalled();
});

it("never throws or claims success when telemetry is unavailable", () => {
  jest.mocked(Sentry.isEnabled).mockReturnValueOnce(false);
  expect(emit(base)).toBe(false);
  jest.mocked(Sentry.logger.info).mockImplementationOnce(() => {
    throw new Error("offline");
  });
  expect(emit(base)).toBe(false);
});
