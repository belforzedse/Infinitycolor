import { ApiClient } from "@repo/api/client";
import { apiClient } from "@/lib/api-client";
import { API_BASE_URL, ERROR_MESSAGES } from "@/constants/api";

jest.mock("../../lib/central-auth", () => ({
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

jest.mock("../../lib/api-cache", () => ({
  apiCache: undefined,
}));

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;
const mockedCentralAuth = jest.requireMock("../../lib/central-auth") as {
  centralAuth: {
    tokenManager: { getToken: jest.Mock; expire: jest.Mock; clearForLogout: jest.Mock };
  };
};

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

describe("ApiClient", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue(null);
    mockedCentralAuth.centralAuth.tokenManager.expire.mockReset();
    mockedCentralAuth.centralAuth.tokenManager.clearForLogout.mockReset();
    localStorageMock.getItem.mockClear();
    jest.clearAllTimers();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("GET requests", () => {
    it("makes a successful GET request", async () => {
      const mockData = { data: { id: 1, name: "Test" } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      });

      const result = await apiClient.get("/test");

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/test`,
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Accept: "application/json",
          }),
        }),
      );
      expect(result).toEqual(mockData);
    });

    it("handles empty successful responses", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await expect(apiClient.delete("/test")).resolves.toEqual({});
    });

    it("includes authorization header when token exists", async () => {
      mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue("test-token");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {} }),
      });

      await apiClient.get("/test");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
      expect(localStorageMock.getItem).not.toHaveBeenCalledWith("accessToken");
    });

    it("skips auth for public endpoints", async () => {
      mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue("test-token");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {} }),
      });

      await apiClient.getPublic("/public");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.not.objectContaining({
            Authorization: expect.any(String),
          }),
        }),
      );
    });
  });

  describe("POST requests", () => {
    it("makes a successful POST request with data", async () => {
      const postData = { name: "Test", value: 123 };
      const mockResponse = { data: { id: 1, ...postData } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.post("/test", postData);

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/test`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(postData),
        }),
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe("Error handling", () => {
    it("handles 401 unauthorized errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ message: "Unauthorized" }),
      });

      await expect(apiClient.get("/protected")).rejects.toEqual(
        expect.objectContaining({
          status: 401,
          message: "Unauthorized",
        }),
      );
    });

    it("handles 400 validation errors", async () => {
      const errorResponse = {
        error: {
          message: "Validation failed",
          details: { field: "required" },
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => errorResponse,
      });

      await expect(apiClient.post("/validate", {})).rejects.toEqual(
        expect.objectContaining({
          status: 400,
          message: "Validation failed",
          error: errorResponse.error,
        }),
      );
    });

    it("preserves text error messages from non-JSON responses", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => "Bad gateway",
      });

      await expect(apiClient.get("/test", { retries: 0 })).rejects.toEqual(
        expect.objectContaining({
          status: 502,
          message: "Bad gateway",
        }),
      );
    });

    it("handles network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network Error"));

      await expect(apiClient.get("/test", { retries: 0 })).rejects.toEqual(
        expect.objectContaining({
          status: 500,
          message: ERROR_MESSAGES.DEFAULT,
        }),
      );
    });

    it("handles request timeout", async () => {
      mockFetch.mockImplementationOnce((_, init: RequestInit) => {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

      const requestPromise = apiClient.get("/slow", { timeout: 1000, retries: 0 });
      const rejection = expect(requestPromise).rejects.toEqual(
        expect.objectContaining({
          status: 408,
          message: ERROR_MESSAGES.TIMEOUT,
        }),
      );

      // Header construction awaits the async token provider before installing
      // the request timeout. The async timer helper advances through both the
      // provider microtasks and the eventual abort timer.
      await jest.advanceTimersByTimeAsync(1000);
      await rejection;
    });

    it("throws error when API_BASE_URL is not configured", async () => {
      const client = new ApiClient({ baseUrl: "undefined" });

      await expect(client.get("/test")).rejects.toEqual(
        expect.objectContaining({
          status: 500,
          message: "API base URL is not configured",
        }),
      );
    });
  });

  describe("HTTP Methods", () => {
    const testData = { test: "data" };

    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
    });

    it("makes PUT requests", async () => {
      await apiClient.put("/test", testData);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify(testData),
        }),
      );
    });

    it("makes PATCH requests", async () => {
      await apiClient.patch("/test", testData);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify(testData),
        }),
      );
    });

    it("makes DELETE requests", async () => {
      await apiClient.delete("/test");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "DELETE",
        }),
      );
    });
  });

  describe("Custom options", () => {
    it("includes credentials when withCredentials is true", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      await apiClient.get("/test", { withCredentials: true });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          credentials: "include",
        }),
      );
    });

    it("merges custom headers", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      await apiClient.get("/test", {
        headers: { "Custom-Header": "value" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Custom-Header": "value",
          }),
        }),
      );
    });

    it("suppresses auth redirect when suppressAuthRedirect is true", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ message: "Unauthorized" }),
      });

      await expect(apiClient.get("/test", { suppressAuthRedirect: true })).rejects.toEqual(
        expect.objectContaining({
          status: 401,
        }),
      );
    });
  });
});
