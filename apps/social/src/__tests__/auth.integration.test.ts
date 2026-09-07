import { apiClient } from "@/lib/api-client";
import { handleAuthErrors } from "@/utils/auth";
import { HTTP_STATUS, ERROR_MESSAGES } from "@repo/api";
import { currentUserAtom } from "@/lib/atoms/auth";
import { jotaiStore } from "@/lib/jotaiStore";
import type { MeResponse } from "@/types/user-me";

jest.mock("@/lib/central-auth", () => ({
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
      expire: jest.fn(),
      clearForLogout: jest.fn(),
      peek: jest.fn(),
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
      peek: jest.Mock;
    };
  };
  clearCentralAuthForLogout: jest.Mock;
};

function customerUser(): MeResponse {
  return {
    id: 7,
    Phone: "09120000000",
    FirstName: "Test",
    LastName: "Customer",
    IsActive: true,
    IsVerified: true,
    Bio: null,
    BirthDate: null,
    NationalCode: null,
    Sex: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    roleName: "Customer",
  };
}

describe("Infinitygram authentication flows", () => {
  beforeEach(() => {
    localStorage.clear();
    jotaiStore.set(currentUserAtom, null);
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue(null);
    mockedCentralAuth.centralAuth.tokenManager.expire.mockReset();
    mockedCentralAuth.centralAuth.tokenManager.clearForLogout.mockReset();
    mockedCentralAuth.centralAuth.tokenManager.peek.mockReset().mockReturnValue(null);
    mockedCentralAuth.clearCentralAuthForLogout.mockReset();
  });

  it("clears central session state on unauthorized and never writes accessToken", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: HTTP_STATUS.UNAUTHORIZED,
      json: async () => ({}),
    });

    await expect(apiClient.get("/protected")).rejects.toEqual({
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
    const user = customerUser();
    jotaiStore.set(currentUserAtom, user);
    window.history.pushState({}, "", "/profile");
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: HTTP_STATUS.FORBIDDEN,
      json: async () => ({ error: { message: "Forbidden" } }),
    });

    await expect(apiClient.get("/posts")).rejects.toEqual({
      message: "Forbidden",
      status: HTTP_STATUS.FORBIDDEN,
      errors: undefined,
    });

    expect(mockedCentralAuth.clearCentralAuthForLogout).not.toHaveBeenCalled();
    expect(jotaiStore.get(currentUserAtom)).toEqual(user);
    expect(window.location.pathname).toBe("/profile");
  });
});
