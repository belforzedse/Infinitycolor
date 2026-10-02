import { handleAuthErrors } from "../auth";

jest.mock("@/lib/central-auth", () => ({
  readAuthStateVersion: jest.fn(() => 0),
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
      getTokenOutcome: jest.fn(async (options: unknown) => {
        try {
          const token = await (
            jest.requireMock("@/lib/central-auth") as {
              centralAuth: {
                tokenManager: { getToken: (options: unknown) => Promise<string | null> };
              };
            }
          ).centralAuth.tokenManager.getToken(options);
          return token ? { state: "authenticated", token } : { state: "unauthenticated" };
        } catch (error) {
          return { state: "unavailable", reasonCode: "network" };
        }
      }),
      expire: jest.fn(),
      clearForLogout: jest.fn(),
    },
  },
  clearCentralAuthForLogout: jest.fn(),
  centralLoginUrl: jest.fn(() => "http://localhost:2889/auth"),
}));

const mockedCentralAuth = jest.requireMock("@/lib/central-auth") as {
  clearCentralAuthForLogout: jest.Mock;
  centralAuth: { tokenManager: { getToken: jest.Mock } };
};

// Mock Next.js router
const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
}));

// Mock localStorage
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};
Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

describe("Auth utilities", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
    localStorageMock.removeItem.mockClear();
    localStorageMock.getItem.mockClear();
    mockedCentralAuth.clearCentralAuthForLogout.mockReset();
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
  });

  describe("handleAuthErrors", () => {
    it("clears in-memory central auth state on a 401 error when a token refresh also fails", async () => {
      mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValueOnce(null);
      const error = { status: 401, message: "Unauthorized" };

      await handleAuthErrors(error);

      expect(mockedCentralAuth.clearCentralAuthForLogout).toHaveBeenCalledTimes(1);
      expect(localStorageMock.removeItem).not.toHaveBeenCalledWith("accessToken");
    });

    it("does not clear auth state on a 401 when a silent token refresh succeeds", async () => {
      mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValueOnce("fresh-token");
      const error = { status: 401, message: "Unauthorized" };

      await handleAuthErrors(error);

      expect(mockedCentralAuth.centralAuth.tokenManager.getToken).toHaveBeenCalledWith({
        forceRefresh: true,
      });
      expect(mockedCentralAuth.clearCentralAuthForLogout).not.toHaveBeenCalled();
    });

    it("redirects non-admin users to account on 403 error", () => {
      const error = { status: 403, message: "Forbidden" };

      handleAuthErrors(error, false);

      // Should not clear token for 403 errors
      expect(localStorageMock.removeItem).not.toHaveBeenCalled();
    });

    it("allows admin users to continue on 403 error", () => {
      const error = { status: 403, message: "Forbidden" };

      handleAuthErrors(error, true);

      expect(localStorageMock.removeItem).not.toHaveBeenCalled();
    });

    it("does nothing for non-auth errors", () => {
      const error = { status: 400, message: "Bad Request" };

      handleAuthErrors(error);

      expect(localStorageMock.removeItem).not.toHaveBeenCalled();
    });

    it("handles null error gracefully", () => {
      expect(() => handleAuthErrors(null)).not.toThrow();
    });

    it("handles undefined error gracefully", () => {
      expect(() => handleAuthErrors(undefined as any)).not.toThrow();
    });

    it("handles error without status gracefully", () => {
      const error = { message: "Some error" } as any;

      expect(() => handleAuthErrors(error)).not.toThrow();
    });
  });
});

describe("temporary unauthorized recovery", () => {
  it.each([
    new TypeError("Failed to fetch"),
    new DOMException("timed out", "AbortError"),
    { status: 503 },
  ])("does not publish logout or navigate after %s", async (cause) => {
    mockedCentralAuth.clearCentralAuthForLogout.mockClear();
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockRejectedValueOnce(cause);
    await handleAuthErrors({ status: 401 });
    expect(mockedCentralAuth.clearCentralAuthForLogout).not.toHaveBeenCalled();
  });
});
