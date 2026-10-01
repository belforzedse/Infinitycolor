import * as Sentry from "@sentry/nextjs";
import { runStagingSentryProbe } from "../sentry-staging-probe";
jest.mock("@sentry/nextjs", () => ({
  logger: { info: jest.fn() },
  captureException: jest.fn(),
  isEnabled: jest.fn(() => true),
}));

const id = "verification_20261001";
const originalEnvironment = process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT;
const originalProbe = process.env.NEXT_PUBLIC_SENTRY_DIAGNOSTICS_PROBE_ID;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(Sentry.isEnabled).mockReturnValue(true);
  window.sessionStorage.clear();
  window.history.replaceState({}, "", `/?sentry_probe=${id}`);
  process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT = "staging";
  process.env.NEXT_PUBLIC_SENTRY_DIAGNOSTICS_PROBE_ID = id;
});
afterEach(() => {
  jest.restoreAllMocks();
  if (originalEnvironment === undefined) delete process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT;
  else process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT = originalEnvironment;
  if (originalProbe === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DIAGNOSTICS_PROBE_ID;
  else process.env.NEXT_PUBLIC_SENTRY_DIAGNOSTICS_PROBE_ID = originalProbe;
});

it("emits one safe Log and a first-party exception per matching session", () => {
  expect(runStagingSentryProbe()).toBe(true);
  expect(runStagingSentryProbe()).toBe(false);
  expect(Sentry.logger.info).toHaveBeenCalledTimes(1);
  expect(Sentry.logger.info).toHaveBeenCalledWith("diagnostics.probe", {
    area: "browser",
    stage: "browser",
    reasonCode: id,
    diagnostic_event: "diagnostics.probe",
  });
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  const [error, context] = jest.mocked(Sentry.captureException).mock.calls[0];
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("StagingSourceMapProbeError");
  expect((error as Error).stack).toContain("captureStagingSourceMapProbe");
  expect(context).toMatchObject({
    level: "info",
    fingerprint: ["staging-source-map-probe"],
    tags: { diagnostic_event: "diagnostics.probe", area: "browser", reasonCode: id },
  });
});

it.each(["production", "development", ""])('cannot run in environment "%s"', (env) => {
  process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT = env;
  expect(runStagingSentryProbe()).toBe(false);
  expect(Sentry.logger.info).not.toHaveBeenCalled();
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

it.each(["/", "/?sentry_probe=other", `/?sentry_probe=${id}&sentry_probe=${id}`])(
  "requires one exact operator parameter: %s",
  (url) => {
    window.history.replaceState({}, "", url);
    expect(runStagingSentryProbe()).toBe(false);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  },
);

it("rejects disabled and invalid settings", () => {
  for (const value of ["", "private/value", "x".repeat(65)]) {
    process.env.NEXT_PUBLIC_SENTRY_DIAGNOSTICS_PROBE_ID = value;
    expect(runStagingSentryProbe()).toBe(false);
  }
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

it("fails closed for disabled telemetry or unavailable session storage", () => {
  jest.mocked(Sentry.isEnabled).mockReturnValueOnce(false);
  expect(runStagingSentryProbe()).toBe(false);
  jest.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new Error("denied");
  });
  expect(runStagingSentryProbe()).toBe(false);
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

it("never disrupts rendering or repeats reports when transport throws", () => {
  jest.mocked(Sentry.logger.info).mockImplementationOnce(() => {
    throw new Error("offline");
  });
  expect(runStagingSentryProbe()).toBe(false);
  expect(runStagingSentryProbe()).toBe(false);
  expect(Sentry.captureException).not.toHaveBeenCalled();
  window.sessionStorage.clear();
  jest.mocked(Sentry.captureException).mockImplementationOnce(() => {
    throw new Error("offline");
  });
  expect(runStagingSentryProbe()).toBe(false);
  expect(runStagingSentryProbe()).toBe(false);
});
