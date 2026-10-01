import * as Sentry from "@sentry/node";
import {
  beforeSendDiagnosticLog,
  reportExpectedDiagnostic,
  routeExpectedDiagnostic,
} from "../diagnostic-log";
jest.mock("@sentry/node", () => ({ logger: { info: jest.fn() }, captureMessage: jest.fn(), isEnabled: jest.fn(() => true) }));

describe("expected diagnostics rollout", () => {
  const original = process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS;
  afterEach(() => {
    process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS = original;
    jest.clearAllMocks();
    jest.mocked(Sentry.isEnabled).mockReturnValue(true);
  });

  it("keeps the Issue report until ingestion is explicitly verified", () => {
    delete process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS;
    reportExpectedDiagnostic("snappay.not_found.shadow_decision", {
      level: "info",
      tags: { gateway: "snappay" },
      extra: { orderId: 123, token: "private", kind: "not_found_confirmed" },
    });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.logger.info).toHaveBeenCalledWith("snappay.not_found.shadow_decision", {
      gateway: "snappay",
      kind: "not_found_confirmed",
      diagnostic_event: "snappay.not_found.shadow_decision",
    });
  });
  it("routes verified expected outcomes to Logs and fails safely if the logger fails", () => {
    process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS = "true";
    expect(
      routeExpectedDiagnostic("payment.result:issue", { reasonCode: "return_without_result" }),
    ).toBe(true);
    jest.mocked(Sentry.logger.info).mockImplementationOnce(() => {
      throw new Error("offline");
    });
    reportExpectedDiagnostic("snappay.registered.shadow_decision", { level: "info" });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
  it("rejects arbitrary bodies, private attributes and nonfinite numbers", () => {
    expect(beforeSendDiagnosticLog({ message: "private request body" })).toBeNull();
    expect(
      beforeSendDiagnosticLog({
        message: "diagnostics.probe",
        attributes: {
          gateway: "snappay",
          userId: 7,
          reasonCode: "https://private.test/?token=x",
          itemCount: Infinity,
        },
      }),
    ).toEqual({ message: "diagnostics.probe", attributes: { gateway: "snappay" } });
  });
  it("does not claim Logs ownership when the configured SDK is disabled", () => {
    process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS = "true";
    jest.mocked(Sentry.isEnabled).mockReturnValue(false);
    expect(routeExpectedDiagnostic("checkout.failure")).toBe(false);
    expect(Sentry.logger.info).not.toHaveBeenCalled();
  });
});
