import * as Sentry from "@sentry/nextjs";
import {
  completeStorefrontRecovery,
  exhaustStorefrontRecovery,
  RECOVERY_WINDOW_MS,
  reportStorefrontError,
  retryStorefrontError,
} from "../storefront-recovery";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn(), logger: { info: jest.fn() } }));
let now = 1_000_000;
beforeEach(() => {
  now += RECOVERY_WINDOW_MS + 1;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  jest.clearAllMocks();
});
afterEach(() => jest.restoreAllMocks());

it("shares one retry window across surfaces and reports exhaustion once", () => {
  const retry = jest.fn();
  const error = Object.assign(new Error("Connection closed."), { digest: "12345" });
  expect(retryStorefrontError(error, "catalog", retry)).toBe(true);
  expect(retryStorefrontError(error, "root-layout", retry)).toBe(false);
  expect(retry).toHaveBeenCalledTimes(1);
  reportStorefrontError(error, "catalog");
  reportStorefrontError(new Error("Connection closed."), "catalog");
  reportStorefrontError(error, "catalog");
  // Different digests remain distinct; the same error is deduplicated.
  expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  expect(Sentry.captureException).toHaveBeenCalledWith(error, {
    tags: {
      recovery_surface: "catalog",
      recovery_outcome: "exhausted",
      next_error_digest: "12345",
    },
  });
});
it("logs a confirmed successful retry and retains genuine hydration errors", () => {
  const error = new Error("Failed to fetch");
  expect(retryStorefrontError(error, "product", jest.fn())).toBe(true);
  completeStorefrontRecovery();
  completeStorefrontRecovery();
  expect(
    jest.mocked(Sentry.logger.info).mock.calls.filter(([event]) => event === "storefront.recovery"),
  ).toHaveLength(2);
  expect(Sentry.logger.info).toHaveBeenLastCalledWith(
    "storefront.recovery",
    expect.objectContaining({ recovery_outcome: "recovered" }),
  );
  const hydration = new Error(
    "Hydration failed because the server rendered HTML did not match the client",
  );
  expect(retryStorefrontError(hydration, "root", jest.fn())).toBe(false);
  reportStorefrontError(hydration, "root");
  expect(Sentry.captureException).toHaveBeenCalledWith(hydration, {
    tags: { recovery_surface: "root", recovery_outcome: "failed" },
  });
});
it("does not claim recovery after navigation and permits another incident after the window", () => {
  const error = new Error("Load failed");
  window.history.replaceState(null, "", "/first");
  retryStorefrontError(error, "catalog", jest.fn());
  window.history.replaceState(null, "", "/second");
  completeStorefrontRecovery();
  expect(Sentry.logger.info).not.toHaveBeenCalledWith(
    "storefront.recovery",
    expect.objectContaining({ recovery_outcome: "recovered" }),
  );
  reportStorefrontError(error, "catalog");
  now += RECOVERY_WINDOW_MS + 1;
  reportStorefrontError(error, "catalog");
  expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  window.history.replaceState(null, "", "/");
});

it("does not let an old boundary timer report after a confirmed recovery", () => {
  const error = new Error("Connection closed.");
  retryStorefrontError(error, "catalog", jest.fn());
  completeStorefrontRecovery("catalog");
  now += RECOVERY_WINDOW_MS;
  expect(exhaustStorefrontRecovery(error, "catalog")).toBe(false);
  expect(Sentry.captureException).not.toHaveBeenCalled();
});
it("deduplicates the same digest across remounted boundaries", () => {
  reportStorefrontError(
    Object.assign(new Error("Connection closed."), { digest: "shared" }),
    "catalog",
  );
  reportStorefrontError(
    Object.assign(new Error("Connection closed."), { digest: "shared" }),
    "root-layout",
  );
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
});
