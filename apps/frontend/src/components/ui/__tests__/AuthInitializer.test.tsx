import React from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import type { MeResponse } from "../../../services/user/me";
import jotaiStore from "../../../lib/jotaiStore";
import { currentUserAtom } from "../../../lib/atoms/auth";
import { AUTH_STATE_EVENT } from "@repo/auth-core/contracts";

jest.mock("../../../services/user", () => ({
  __esModule: true,
  default: {
    me: jest.fn(),
  },
}));

jest.mock("../../../lib/central-auth", () => ({
  centralAuthOrigin: "http://localhost:2889",
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
      expire: jest.fn(),
    },
  },
  initializeCentralAuthBrowser: jest.fn(),
  subscribeToAuthState: jest.fn((listener: (event: { type: string; at: number }) => void) => {
    const handler = (event: Event) => listener((event as CustomEvent).detail);
    window.addEventListener(AUTH_STATE_EVENT, handler);
    return () => window.removeEventListener(AUTH_STATE_EVENT, handler);
  }),
}));

const AuthInitializer = require("../AuthInitializer")
  .default as typeof import("../AuthInitializer").default;
const UserService = require("../../../services/user")
  .default as typeof import("../../../services/user").default;
const mockedMe = UserService.me as jest.MockedFunction<typeof UserService.me>;
const mockedCentralAuth = jest.requireMock("../../../lib/central-auth") as {
  centralAuth: { tokenManager: { getToken: jest.Mock; expire: jest.Mock } };
};

const buildUser = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  Bio: null,
  BirthDate: null,
  FirstName: "Test",
  IsActive: true,
  IsVerified: true,
  LastName: "User",
  NationalCode: null,
  Phone: "09120000000",
  Sex: null,
  createdAt: new Date().toISOString(),
  id: overrides.id ?? 1,
  updatedAt: new Date().toISOString(),
  isAdmin: overrides.isAdmin,
  UserName: overrides.UserName,
  roleName: overrides.roleName ?? null,
  ...overrides,
});

describe("AuthInitializer", () => {
  beforeEach(() => {
    mockedMe.mockReset();
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue("jwt");
    mockedCentralAuth.centralAuth.tokenManager.expire.mockReset();
    localStorage.clear();
    jotaiStore.set(currentUserAtom, null);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 204 } as Response) as jest.MockedFunction<
      typeof fetch
    >;
  });

  it("clears a stale route hint when no central session exists", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValueOnce(null);

    await act(async () => {
      render(
        <Provider store={jotaiStore}>
          <AuthInitializer />
        </Provider>,
      );
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/auth/route-hint",
        expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
      );
    });
    expect(mockedMe).not.toHaveBeenCalled();
  });

  it("refreshes user data when logging out and logging in as another role", async () => {
    mockedMe.mockResolvedValueOnce(
      buildUser({
        id: 1,
        roleName: "Store manager",
      }),
    );

    await act(async () => {
      render(
        <Provider store={jotaiStore}>
          <AuthInitializer />
        </Provider>,
      );
    });

    await waitFor(() => {
      expect(jotaiStore.get(currentUserAtom)?.roleName).toBe("Store manager");
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(AUTH_STATE_EVENT, { detail: { type: "logout", at: Date.now() } }),
      );
    });

    await waitFor(() => {
      expect(jotaiStore.get(currentUserAtom)).toBeNull();
    });

    mockedMe.mockResolvedValueOnce(
      buildUser({
        id: 2,
        roleName: "SuperAdmin",
        isAdmin: true,
      }),
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(AUTH_STATE_EVENT, {
          detail: { type: "session-changed", at: Date.now() },
        }),
      );
    });

    await waitFor(() => {
      expect(jotaiStore.get(currentUserAtom)?.roleName).toBe("SuperAdmin");
    });
  });

  it("preserves identity and route hints during a temporary API failure", async () => {
    const existing = buildUser({ id: 17, roleName: "SuperAdmin", isAdmin: true });
    jotaiStore.set(currentUserAtom, existing);
    mockedMe.mockRejectedValueOnce({ status: 503, message: "temporarily unavailable" });

    await act(async () => {
      render(
        <Provider store={jotaiStore}>
          <AuthInitializer />
        </Provider>,
      );
    });

    await waitFor(() => expect(mockedMe).toHaveBeenCalledTimes(1));
    expect(jotaiStore.get(currentUserAtom)).toEqual(existing);
    expect(mockedCentralAuth.centralAuth.tokenManager.expire).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
