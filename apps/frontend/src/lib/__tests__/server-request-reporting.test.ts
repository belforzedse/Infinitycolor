const mockScope = { setTag: jest.fn(), setFingerprint: jest.fn() };
jest.mock("@sentry/nextjs", () => ({
  withScope: jest.fn((callback) => callback(mockScope)),
  captureRequestError: jest.fn(),
}));

import * as Sentry from "@sentry/nextjs";
import { onRequestError } from "../../instrumentation";

const request = { path: "/plp/category/example", method: "GET", headers: {} };
const context = {
  routerKind: "App Router" as const,
  routePath: "/plp/category/[slug]",
  routeType: "render" as const,
  renderSource: "react-server-components" as const,
  revalidateReason: undefined,
};

afterEach(() => {
  jest.clearAllMocks();
});

it("reports one server exception with its digest and redacted cause classification", async () => {
  const error = Object.assign(new Error("Unable to load products"), {
    name: "PLPProductsError",
    code: "FETCH_FAILED",
    digest: "4073695856",
    failureStage: "request",
    cause: Object.assign(new TypeError("Catalog request failed"), { code: "ECONNREFUSED" }),
  });
  await onRequestError(error, request, context);
  expect(Sentry.captureRequestError).toHaveBeenCalledTimes(1);
  expect(Sentry.captureRequestError).toHaveBeenCalledWith(error, request, context);
  expect(mockScope.setTag).toHaveBeenCalledWith("next_error_digest", "4073695856");
  expect(mockScope.setTag).toHaveBeenCalledWith("catalog_cause_code", "ECONNREFUSED");
});

it("does not replace the render error when telemetry fails", async () => {
  (Sentry.captureRequestError as jest.Mock).mockImplementationOnce(() => {
    throw new Error("telemetry unavailable");
  });
  await expect(
    onRequestError(new Error("render failure"), request, context),
  ).resolves.toBeUndefined();
});

it("keeps an asynchronous telemetry rejection from replacing the render error", async () => {
  (Sentry.captureRequestError as jest.Mock).mockRejectedValueOnce(
    new Error("telemetry flush unavailable"),
  );
  await expect(
    onRequestError(new Error("render failure"), request, context),
  ).resolves.toBeUndefined();
});
