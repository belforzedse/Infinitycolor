import { ApiClient } from "@repo/api/client";

const response = (status: number, payload: unknown) => ({
  ok: false,
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
    global.fetch = jest.fn().mockResolvedValue(response(409, {
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
    })) as jest.Mock;
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
    global.fetch = jest.fn().mockResolvedValue(response(400, {
      error: {
        message: "پرداخت قبلی هنوز در حال بررسی است",
        details: { data: { errorCode: "PAYMENT_IN_PROGRESS" } },
      },
    })) as jest.Mock;
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
});
