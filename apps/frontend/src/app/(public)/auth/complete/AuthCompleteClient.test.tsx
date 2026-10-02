import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { updateRouteHint } from "@repo/auth-core/browser";
import { currentUserAtom } from "@/lib/atoms/auth";
import { jotaiStore } from "@/lib/jotaiStore";
import { centralAuth, readAuthStateVersion } from "@/lib/central-auth";
import UserService from "@/services/user";
import AuthCompleteClient from "./AuthCompleteClient";

jest.mock("@/lib/central-auth", () => ({
  centralAuthOrigin: "https://auth.test",
  readAuthStateVersion: jest.fn(() => 0),
  initializeCentralAuthBrowser: jest.fn(),
  centralAuth: { tokenManager: { getToken: jest.fn(), expire: jest.fn() } },
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
it("retains the loop limit for confirmed invalid credentials", async () => {
  render(<AuthCompleteClient returnPath="/account" attempt={2} callbackError="invalid_grant" />);
  await screen.findByRole("alert");
  expect(centralAuth.tokenManager.getToken).not.toHaveBeenCalled();
  expect(updateRouteHint).not.toHaveBeenCalled();
});
