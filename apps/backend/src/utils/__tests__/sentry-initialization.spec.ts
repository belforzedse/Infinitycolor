import * as Sentry from "@sentry/node";
jest.mock("@sentry/node", () => ({
  init: jest.fn(),
  logger: { info: jest.fn() },
  isEnabled: jest.fn(() => true),
}));

let initialize: typeof import("../sentry-initialization").initializeBackendSentry;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(Sentry.init).mockReset();
  jest.isolateModules(() => {
    initialize = require("../sentry-initialization").initializeBackendSentry;
  });
});

it("initializes an independent scheduler with release attribution and one staging Log", () => {
  const env = {
    SENTRY_DSN: "https://public@example.test/1",
    SENTRY_ENVIRONMENT: "staging",
    RELEASE_SHA: "candidate",
    SENTRY_DIAGNOSTICS_PROBE_ID: "verification_20261001",
    PROCESS_ROLE: "scheduler",
  };
  expect(initialize(env)).toBe(true);
  expect(initialize(env)).toBe(true);
  expect(Sentry.init).toHaveBeenCalledTimes(1);
  expect(Sentry.init).toHaveBeenCalledWith(
    expect.objectContaining({
      enabled: true,
      environment: "staging",
      release: "candidate",
      enableLogs: true,
    }),
  );
  expect(Sentry.logger.info).toHaveBeenCalledTimes(1);
  expect(Sentry.logger.info).toHaveBeenCalledWith(
    "diagnostics.probe",
    expect.objectContaining({
      area: "scheduler",
      reasonCode: "verification_20261001",
    }),
  );
});

it("keeps SDK initialization failure harmless", () => {
  jest.mocked(Sentry.init).mockImplementationOnce(() => {
    throw new Error("unavailable");
  });
  expect(initialize({ NODE_ENV: "production" })).toBe(false);
  expect(Sentry.logger.info).not.toHaveBeenCalled();
});

it("does not emit production probes and disables an unconfigured SDK", () => {
  expect(
    initialize({
      SENTRY_ENVIRONMENT: "production",
      SENTRY_DIAGNOSTICS_PROBE_ID: "verification_20261001",
    }),
  ).toBe(true);
  expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  expect(Sentry.logger.info).not.toHaveBeenCalled();
});
