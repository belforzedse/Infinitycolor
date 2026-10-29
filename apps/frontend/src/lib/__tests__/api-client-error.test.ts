import { ApiClient } from "@repo/api/client";
import { ApiCache } from "@repo/api/cache";
import { waitFor } from "@testing-library/react";

const response = (status: number, payload: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
});

describe("ApiClient product error contract", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("preserves a Strapi conflict payload needed for checkout recovery", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response(409, {
        data: null,
        error: {
          status: 409,
          message: "قیمت یا موجودی سبد خرید تغییر کرده است",
          details: {
            data: {
              errorCode: "CHECKOUT_QUOTE_CHANGED",
              quote: { quoteHash: "sha256:new", financialSummary: { total: 125_000 } },
            },
          },
        },
      }),
    ) as jest.Mock;
    const client = new ApiClient({
      baseUrl: "https://api.example.test/api",
      retryConfig: {
        maxRetries: 0,
        baseDelay: 1,
        maxDelay: 1,
        retryableStatusCodes: [],
      },
    });

    await expect(client.post("/carts/finalize", {})).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        message: "قیمت یا موجودی سبد خرید تغییر کرده است",
        errorCode: "CHECKOUT_QUOTE_CHANGED",
        data: expect.objectContaining({
          quote: expect.objectContaining({ quoteHash: "sha256:new" }),
        }),
      }),
    );
  });

  it("preserves structured 400 error details as well", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response(400, {
        error: {
          message: "پرداخت قبلی هنوز در حال بررسی است",
          details: { data: { errorCode: "PAYMENT_IN_PROGRESS" } },
        },
      }),
    ) as jest.Mock;
    const client = new ApiClient({
      baseUrl: "https://api.example.test/api",
      retryConfig: {
        maxRetries: 0,
        baseDelay: 1,
        maxDelay: 1,
        retryableStatusCodes: [],
      },
    });

    await expect(client.post("/carts/finalize", {})).rejects.toEqual(
      expect.objectContaining({
        status: 400,
        errorCode: "PAYMENT_IN_PROGRESS",
        data: { errorCode: "PAYMENT_IN_PROGRESS" },
      }),
    );
  });

  it("does not retry a mutation after a retryable server response", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response(503, {
        error: { message: "temporarily unavailable" },
      }),
    ) as jest.Mock;
    const client = new ApiClient({
      baseUrl: "https://api.example.test/api",
      retryConfig: {
        maxRetries: 2,
        baseDelay: 0,
        maxDelay: 0,
        retryableStatusCodes: [503],
      },
    });

    await expect(client.post("/cart-items", { quantity: 1 })).rejects.toEqual(
      expect.objectContaining({ status: 503 }),
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("retains bounded retries for safe reads", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response(503, { error: { message: "try again" } }))
      .mockResolvedValueOnce(response(200, { data: { id: 42 } })) as jest.Mock;
    const client = new ApiClient({
      baseUrl: "https://api.example.test/api",
      retryConfig: {
        maxRetries: 2,
        baseDelay: 0,
        maxDelay: 0,
        retryableStatusCodes: [503],
      },
    });

    await expect(client.get<{ id: number }>("/products/42")).resolves.toEqual({
      data: { id: 42 },
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not raise an unhandled rejection when a cached GET fails (Sentry: Object captured as promise rejection)", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response(404, {
        message: "Wallet not found for this user",
      }),
    ) as jest.Mock;

    const cache = new ApiCache({
      buildVersion: "test",
      cacheConfigs: [{ pattern: /./, config: { maxAge: 60_000, staleWhileRevalidate: 0 } }],
      noCachePatterns: [],
    });

    const client = new ApiClient({
      baseUrl: "https://api.example.test/api",
      apiCache: cache,
      retryConfig: { maxRetries: 0, baseDelay: 1, maxDelay: 1, retryableStatusCodes: [] },
    });

    const onUnhandledRejection = jest.fn();
    process.on("unhandledRejection", onUnhandledRejection);

    await expect(client.get("/local-user-wallet/me")).rejects.toEqual(
      expect.objectContaining({ status: 404, message: "Wallet not found for this user" }),
    );

    // Let the internal setPending cleanup chain settle on the task queue.
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off("unhandledRejection", onUnhandledRejection);
    expect(onUnhandledRejection).not.toHaveBeenCalled();
  });

  it("continues to coalesce ordinary concurrent GET requests", async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    global.fetch = jest.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ) as jest.Mock;
    const client = new ApiClient({
      baseUrl: "https://api.example.test/api",
      apiCache: new ApiCache({ buildVersion: "test", cacheConfigs: [], noCachePatterns: [] }),
    });
    const first = client.get("/products/42");
    const second = client.get("/products/42");
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    release(response(200, { data: { id: 42 } }));
    await expect(first).resolves.toEqual({ data: { id: 42 } });
    await expect(second).resolves.toEqual({ data: { id: 42 } });
  });

  it("can bypass an earlier account's pending GET without altering the request URL", async () => {
    let token = "account-a";
    let release!: (value: ReturnType<typeof response>) => void;
    global.fetch = jest.fn((_url, options) => {
      if (new Headers(options?.headers).get("Authorization") === "Bearer account-a") {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(response(200, { data: { id: 2 } }));
    }) as jest.Mock;
    const client = new ApiClient({
      baseUrl: "https://api.example.test/api",
      apiCache: new ApiCache({ buildVersion: "test", cacheConfigs: [], noCachePatterns: [] }),
      getAuthToken: () => token,
    });
    const first = client.get("/product-likes/user-likes");
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    token = "account-b";
    await expect(client.get("/product-likes/user-likes", { deduplicate: false })).resolves.toEqual({
      data: { id: 2 },
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls.map(([url]) => url)).toEqual([
      "https://api.example.test/api/product-likes/user-likes",
      "https://api.example.test/api/product-likes/user-likes",
    ]);
    release(response(200, { data: { id: 1 } }));
    await expect(first).resolves.toEqual({ data: { id: 1 } });
  });
});
