import React from "react";
import * as Sentry from "@sentry/nextjs";
import { act, render, screen, waitFor } from "@testing-library/react";
import { updateRouteHint } from "@repo/auth-core/browser";
import { currentUserAtom } from "@/lib/atoms/auth";
import { jotaiStore } from "@/lib/jotaiStore";
import { centralAuth, readAuthStateVersion } from "@/lib/central-auth";
import UserService from "@/services/user";
import AuthCompleteClient from "./AuthCompleteClient";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("@/lib/central-auth", () => ({
  centralAuthOrigin: "https://auth.test",
  readAuthStateVersion: jest.fn(() => 0),
  initializeCentralAuthBrowser: jest.fn(),
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
      getTokenOutcome: jest.fn(async () => {
        const token = await jest
          .requireMock("@/lib/central-auth")
          .centralAuth.tokenManager.getToken();
        return token ? { state: "authenticated", token } : { state: "unauthenticated" };
      }),
      expire: jest.fn(),
    },
  },
}));
jest.mock("@/services/user", () => ({ __esModule: true, default: { me: jest.fn() } }));
jest.mock("@repo/auth-core/browser", () => ({
  ...jest.requireActual("@repo/auth-core/browser"),
  updateRouteHint: jest.fn(),
  withTransientAuthRetry: (operation: () => Promise<unknown>) => operation(),
}));
jest.mock("@/lib/diagnostic-log", () => ({ logDiagnostic: jest.fn() }));
const user = { id: 1, FirstName: "Test", LastName: "User", isAdmin: false };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(readAuthStateVersion).mockReturnValue(0);
  jest.mocked(centralAuth.tokenManager.getToken).mockResolvedValue("existing-token");
  jest.mocked(UserService.me).mockResolvedValue(user as never);
  jest.mocked(updateRouteHint).mockResolvedValue();
  jotaiStore.set(currentUserAtom, null);
});
it("recovers an ambiguous callback through the existing session without exchanging a grant", async () => {
  const fetchSpy = jest.fn();
  global.fetch = fetchSpy;
  render(
    <AuthCompleteClient
      returnPath="/account"
      attempt={0}
      callbackError="grant_exchange_unavailable"
    />,
  );
  await waitFor(() => expect(jotaiStore.get(currentUserAtom)).toEqual(user));
  expect(updateRouteHint).toHaveBeenCalledWith("PUT");
  expect(fetchSpy).not.toHaveBeenCalled();
});
it.each([403, 503])("shows a retry state for token HTTP %s without logging out", async (status) => {
  jest.mocked(centralAuth.tokenManager.getToken).mockRejectedValue({ status });
  render(
    <AuthCompleteClient
      returnPath="/account"
      attempt={0}
      callbackError="grant_exchange_unavailable"
    />,
  );
  await screen.findByRole("alert");
  expect(centralAuth.tokenManager.expire).not.toHaveBeenCalled();
  expect(updateRouteHint).not.toHaveBeenCalled();
  expect(UserService.me).not.toHaveBeenCalled();
});
it("does not restore a profile or route hint after identity invalidation", async () => {
  let resolve!: (value: unknown) => void;
  jest.mocked(UserService.me).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<AuthCompleteClient returnPath="/account" attempt={0} />);
  await waitFor(() => expect(UserService.me).toHaveBeenCalled());
  jest.mocked(readAuthStateVersion).mockReturnValue(1);
  await act(async () => resolve(user));
  expect(jotaiStore.get(currentUserAtom)).toBeNull();
  expect(updateRouteHint).not.toHaveBeenCalled();
});
it("recovers after StrictMode remount without replaying the single-use exchange", async () => {
  render(
    <React.StrictMode>
      <AuthCompleteClient
        returnPath="/account"
        attempt={0}
        callbackError="grant_exchange_unavailable"
      />
    </React.StrictMode>,
  );
  await waitFor(() => expect(jotaiStore.get(currentUserAtom)).toEqual(user));
  expect(updateRouteHint).toHaveBeenCalledTimes(1);
});
it("retains the loop limit only after the session is confirmed absent", async () => {
  jest.mocked(centralAuth.tokenManager.getToken).mockResolvedValue(null);
  render(<AuthCompleteClient returnPath="/account" attempt={2} callbackError="invalid_grant" />);
  await screen.findByRole("alert");
  expect(centralAuth.tokenManager.getToken).toHaveBeenCalled();
  expect(updateRouteHint).not.toHaveBeenCalled();
});

it.each(["invalid_grant", "grant_exchange_failed"])(
  "checks the existing session after %s rather than assuming logout",
  async (callbackError) => {
    render(<AuthCompleteClient returnPath="/account" attempt={1} callbackError={callbackError} />);
    await waitFor(() => expect(jotaiStore.get(currentUserAtom)).toEqual(user));
    expect(centralAuth.tokenManager.expire).not.toHaveBeenCalled();
    expect(updateRouteHint).toHaveBeenCalledTimes(1);
    expect(updateRouteHint).toHaveBeenCalledWith("PUT");
  },
);

it("reports the terminal unavailable outcome once while retaining retry UI", async () => {
  jest.mocked(centralAuth.tokenManager.getToken).mockRejectedValue({ status: 503 });
  render(<AuthCompleteClient returnPath="/account" attempt={1} />);
  await screen.findByRole("alert");
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  expect(Sentry.captureException).toHaveBeenCalledWith(
    expect.any(Error),
    expect.objectContaining({
      tags: expect.objectContaining({ operation: "complete", outcome: "unavailable" }),
    }),
  );
  const retry = screen.getByRole("button", { name: "تلاش دوباره" });
  await act(async () => retry.click());
  await screen.findByRole("alert");
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  expect(updateRouteHint).not.toHaveBeenCalled();
});

it("keeps the token failure status and bounded reason in terminal diagnostics", async () => {
  jest.mocked(centralAuth.tokenManager.getTokenOutcome).mockResolvedValueOnce({
    state: "unavailable",
    reasonCode: "http_failure",
    status: 502,
  });
  render(<AuthCompleteClient returnPath="/checkout" attempt={0} />);

  await screen.findByRole("alert");
  expect(Sentry.captureException).toHaveBeenCalledWith(
    expect.objectContaining({ status: 502 }),
    expect.objectContaining({
      tags: expect.objectContaining({ failure_stage: "token" }),
      extra: expect.objectContaining({ http_status: 502, reasonCode: "http_failure" }),
    }),
  );
  expect(centralAuth.tokenManager.expire).not.toHaveBeenCalled();
  expect(updateRouteHint).not.toHaveBeenCalled();
});

it.each(["network", "timeout"] as const)("does not label token %s as a received HTTP 503", async (reasonCode) => {
  jest.mocked(centralAuth.tokenManager.getTokenOutcome).mockResolvedValueOnce({
    state: "unavailable", reasonCode,
  });
  render(<AuthCompleteClient returnPath="/checkout" attempt={0} />);
  await screen.findByRole("alert");
  expect(Sentry.captureException).toHaveBeenCalledWith(
    expect.any(Error),
    expect.objectContaining({ extra: expect.objectContaining({ http_status: undefined, reasonCode }) }),
  );
});
