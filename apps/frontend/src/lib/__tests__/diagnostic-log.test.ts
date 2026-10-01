import * as Sentry from "@sentry/nextjs";
import { beforeSendDiagnosticLog, routeExpectedDiagnostic } from "../diagnostic-log";
import { checkoutDiagnosticDisposition } from "../expected-checkout-sentry";
jest.mock("@sentry/nextjs", () => ({ logger: { info: jest.fn() }, isEnabled: jest.fn(() => true) }));

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SENTRY_EXPECTED_EVENTS_TO_LOGS;
  jest.clearAllMocks();
  jest.mocked(Sentry.isEnabled).mockReturnValue(true);
});
it("requires the verified-ingestion switch and redacts private context", () => {
  expect(
    routeExpectedDiagnostic("checkout.failure", {
      reasonCode: "STOCK_CHANGED",
      orderId: 7,
      email: "private@example.test",
    }),
  ).toBe(false);
  expect(Sentry.logger.info).toHaveBeenCalledWith("checkout.failure", {
    reasonCode: "STOCK_CHANGED",
    diagnostic_event: "checkout.failure",
  });
  process.env.NEXT_PUBLIC_SENTRY_EXPECTED_EVENTS_TO_LOGS = "true";
  expect(routeExpectedDiagnostic("checkout.failure")).toBe(true);
  jest.mocked(Sentry.logger.info).mockImplementationOnce(() => {
    throw new Error("blocked");
  });
  expect(routeExpectedDiagnostic("checkout.failure")).toBe(false);
  expect(beforeSendDiagnosticLog({ message: "unbounded console output" })).toBeNull();
});
it("never infers a shortage or backend ownership from an error title", () => {
  expect(checkoutDiagnosticDisposition("STOCK_RESERVATION_FAILED")).toBe("issue");
  expect(
    checkoutDiagnosticDisposition("STOCK_RESERVATION_FAILED", {
      details: { reason: "database_failure" },
    }),
  ).toBe("issue");
  expect(
    checkoutDiagnosticDisposition("STOCK_RESERVATION_FAILED", {
      details: { reason: "insufficient_stock" },
    }),
  ).toBe("expected");
  expect(checkoutDiagnosticDisposition("UNKNOWN_ERROR", { telemetryOwner: "backend" })).toBe("log");
  expect(checkoutDiagnosticDisposition("UNKNOWN_ERROR")).toBe("issue");
  expect(checkoutDiagnosticDisposition("RESERVATION_LOOKUP_FAILED")).toBe("issue");
});
it("retains Issue reporting when a verified switch is set but the SDK is disabled", () => {
  process.env.NEXT_PUBLIC_SENTRY_EXPECTED_EVENTS_TO_LOGS = "true";
  jest.mocked(Sentry.isEnabled).mockReturnValue(false);
  expect(routeExpectedDiagnostic("checkout.failure")).toBe(false);
  expect(Sentry.logger.info).not.toHaveBeenCalled();
});
