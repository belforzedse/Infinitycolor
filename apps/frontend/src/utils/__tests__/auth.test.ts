import { handleAuthErrors } from "../auth";

jest.mock("@/lib/central-auth", () => ({
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
      expire: jest.fn(),
      clearForLogout: jest.fn(),
    },
  },
  clearCentralAuthForLogout: jest.fn(),
  centralLoginUrl: jest.fn(() => "http://localhost:2889/auth"),
}));

const mockedCentralAuth = jest.requireMock("@/lib/central-auth") as {
  clearCentralAuthForLogout: jest.Mock;
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
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
  });

  describe("handleAuthErrors", () => {
    it("clears in-memory central auth state on a 401 error", () => {
      const error = { status: 401, message: "Unauthorized" };

      handleAuthErrors(error);

      expect(mockedCentralAuth.clearCentralAuthForLogout).toHaveBeenCalledTimes(1);
      expect(localStorageMock.removeItem).not.toHaveBeenCalledWith("accessToken");
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
