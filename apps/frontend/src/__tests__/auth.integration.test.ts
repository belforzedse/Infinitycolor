import { apiClient } from "@/services";
import { handleAuthErrors } from "@/utils/auth";
import { HTTP_STATUS, ERROR_MESSAGES } from "@/constants/api";
import { currentUserAtom } from "@/lib/atoms/auth";
import { jotaiStore } from "@/lib/jotaiStore";

jest.mock("@/lib/central-auth", () => ({
  readAuthStateVersion: jest.fn(() => 0),
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
      getTokenOutcome: jest.fn(async (options: unknown) => {
        const token = await (
          jest.requireMock("@/lib/central-auth") as {
            centralAuth: {
              tokenManager: { getToken: (options: unknown) => Promise<string | null> };
            };
          }
        ).centralAuth.tokenManager.getToken(options);
        return token ? { state: "authenticated", token } : { state: "unauthenticated" };
      }),
      expire: jest.fn(),
      clearForLogout: jest.fn(),
    },
  },
  clearCentralAuthForLogout: jest.fn(),
  centralLoginUrl: jest.fn(() => "http://localhost:2889/auth"),
}));

const mockedCentralAuth = jest.requireMock("@/lib/central-auth") as {
  centralAuth: {
    tokenManager: {
      getToken: jest.Mock;
      expire: jest.Mock;
      clearForLogout: jest.Mock;
    };
  };
  clearCentralAuthForLogout: jest.Mock;
};

describe("Authentication flows", () => {
  beforeEach(() => {
    localStorage.clear();
    jotaiStore.set(currentUserAtom, null);
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue(null);
    mockedCentralAuth.centralAuth.tokenManager.expire.mockReset();
    mockedCentralAuth.centralAuth.tokenManager.clearForLogout.mockReset();
    mockedCentralAuth.clearCentralAuthForLogout.mockReset();
  });

  it("clears central session state on unauthorized", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: HTTP_STATUS.UNAUTHORIZED,
      json: async () => ({}),
    });

    await expect(apiClient.get("/protected")).rejects.toMatchObject({
      message: ERROR_MESSAGES.DEFAULT,
      status: HTTP_STATUS.UNAUTHORIZED,
      errors: undefined,
    });

    expect(mockedCentralAuth.clearCentralAuthForLogout).toHaveBeenCalledTimes(1);
    expect(mockedCentralAuth.centralAuth.tokenManager.expire).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("accessToken")).toBeNull();
  });

  it("does not clear session state solely because a user is not an admin", () => {
    handleAuthErrors(null, false);
    expect(mockedCentralAuth.clearCentralAuthForLogout).not.toHaveBeenCalled();
  });

  it("keeps customer session state on forbidden API errors", async () => {
    const user = {
      id: 7,
      Phone: "09120000000",
      FirstName: "Test",
      LastName: "Customer",
      IsActive: true,
      IsVerified: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      roleName: "Customer",
    };

    jotaiStore.set(currentUserAtom, user as any);
    window.history.pushState({}, "", "/orders/123");
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: HTTP_STATUS.FORBIDDEN,
      json: async () => ({ error: { message: "Forbidden" } }),
    });

    await expect(apiClient.get("/orders/123/payment-status")).rejects.toMatchObject({
      message: "Forbidden",
      status: HTTP_STATUS.FORBIDDEN,
      errors: undefined,
    });

    expect(mockedCentralAuth.clearCentralAuthForLogout).not.toHaveBeenCalled();
    expect(jotaiStore.get(currentUserAtom)).toEqual(user);
    expect(window.location.pathname).toBe("/orders/123");
  });
});
