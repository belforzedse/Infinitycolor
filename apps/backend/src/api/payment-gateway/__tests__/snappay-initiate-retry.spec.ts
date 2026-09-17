import { initiateSnappayPayment } from "../services/snappay-orchestrator";
import { createSnappayAdapter } from "../services/snappay";
import {
  hashSnappayCallbackNonce,
  snappayTokenFingerprint,
  displaySnappayFingerprint,
} from "../services/snappay-security";

jest.mock("../../../queue/snappay", () => ({
  enqueueSnappayOperation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/snappay", () => ({
  createSnappayAdapter: jest.fn(),
  getSnappayConfig: jest.fn(),
}));
jest.mock("../services/snappay-category-mapper", () => ({
  mapToSnappayCategory: jest.fn().mockResolvedValue("OTHER"),
}));
jest.mock("../../../utils/stockReservations", () => ({
  releaseOrderReservation: jest.fn().mockResolvedValue(undefined),
  consumeOrderReservation: jest.fn().mockResolvedValue(undefined),
}));

const mockedAdapter = createSnappayAdapter as jest.MockedFunction<typeof createSnappayAdapter>;

const CALLBACK_NONCE = "abcdefghijklmnopqrstuv";
const EXISTING_TOKEN = "provider-payment-token";
const EXISTING_TRANSACTION_ID = "ABC1234567";

function providerResult(overrides: Record<string, unknown> = {}) {
  return {
    successful: true,
    response: { status: "PENDING" },
    diagnostic: { endpoint: "status", httpStatus: 200, providerCode: 0 },
    ...overrides,
  };
}

function createHarness(attemptOverrides: Record<string, unknown> = {}) {
  const transaction = {
    id: 44,
    external_source: "SnappPay",
    external_id: EXISTING_TRANSACTION_ID,
    TrackId: EXISTING_TOKEN,
    GatewayStatus: "REGISTERED",
  };
  const attempt = {
    id: 11,
    attemptId: "attempt-11",
    Status: "Redirected",
    Gateway: "snappay",
    Amount: 2_200_000,
    providerStatus: "REGISTERED",
    providerReference: EXISTING_TRANSACTION_ID,
    redirectUrl: `https://pay.snapp.test/start?paymentToken=${EXISTING_TOKEN}`,
    redirectedAt: new Date(),
    callbackNonce: CALLBACK_NONCE,
    callbackNonceHash: hashSnappayCallbackNonce(CALLBACK_NONCE),
    quoteSnapshot: { financialSummary: { shipping: 20_000, discount: 0, total: 220_000 } },
    providerResponse: {
      tokenFingerprint: displaySnappayFingerprint(snappayTokenFingerprint(EXISTING_TOKEN)),
      tokenAttemptSeq: 1,
    },
    order: {
      id: 22,
      Status: "Paying",
      ReservationStatus: "Reserved",
      user: { id: 5 },
      order_items: [
        {
          id: 71,
          Count: 2,
          PerAmount: 100_000,
          ProductTitle: "Product",
          product_variation: {
            id: 81,
            product: {
              Title: "Product",
              product_main_category: { Title: "Category" },
            },
          },
        },
      ],
    },
    contract: {
      id: 33,
      Amount: 220_000,
      external_id: EXISTING_TRANSACTION_ID,
      contract_transactions: [transaction],
    },
    ...attemptOverrides,
  };
  if (attemptOverrides.transaction) {
    Object.assign(transaction, attemptOverrides.transaction);
  }

  const queries: Record<string, any> = {};
  const strapi = {
    db: {
      connection: { raw: jest.fn().mockResolvedValue({ rows: [{ id: 11 }] }) },
      transaction: jest.fn(async (fn: (args: { trx: { raw: jest.Mock } }) => unknown) =>
        fn({ trx: { raw: jest.fn().mockResolvedValue({ rows: [] }) } }),
      ),
      query: jest.fn((uid: string) => {
        queries[uid] ||= {
          findOne: jest.fn().mockImplementation(async () => {
            if (uid === "api::payment-attempt.payment-attempt") return attempt;
            if (uid === "api::payment-operation.payment-operation") return null;
            if (uid === "api::local-user.local-user") return { id: 5, Phone: "09123456789" };
            return null;
          }),
          update: jest.fn().mockResolvedValue({ id: 1 }),
          create: jest.fn().mockResolvedValue({ id: 99, Status: "Queued", retryCount: 0 }),
        };
        return queries[uid];
      }),
    },
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  } as any;
  return { strapi, attempt, transaction, queries };
}

async function initiate(strapi: any) {
  return initiateSnappayPayment(strapi, {
    paymentAttemptId: 11,
    callbackNonce: CALLBACK_NONCE,
    mobile: "+989123456789",
  });
}

describe("SnappPay checkout initiate retry", () => {
  const configKeys = [
    "SNAPPAY_BASE_URL",
    "SNAPPAY_CLIENT_ID",
    "SNAPPAY_CLIENT_SECRET",
    "SNAPPAY_USERNAME",
    "SNAPPAY_PASSWORD",
    "SNAPPAY_RETURN_URL",
    "FRONTEND_BASE_URL",
  ] as const;
  const originalConfig = Object.fromEntries(configKeys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SNAPPAY_BASE_URL = "https://provider.test.invalid";
    process.env.SNAPPAY_CLIENT_ID = "client";
    process.env.SNAPPAY_CLIENT_SECRET = "secret";
    process.env.SNAPPAY_USERNAME = "username";
    process.env.SNAPPAY_PASSWORD = "password";
    process.env.SNAPPAY_RETURN_URL = "https://storefront.test.invalid/api/snapp/return";
    process.env.FRONTEND_BASE_URL = "https://storefront.test.invalid";
    process.env.SNAPPAY_HARDENED_INITIATION_ENABLED = "true";
  });

  afterAll(() => {
    for (const key of configKeys) {
      const original = originalConfig[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it("reuses the live payment page when status is still pending", async () => {
    const requestPaymentToken = jest.fn();
    const status = jest.fn().mockResolvedValue(providerResult({ response: { status: "PENDING" } }));
    mockedAdapter.mockReturnValue({ status, requestPaymentToken, revert: jest.fn() } as any);
    const { strapi } = createHarness();

    const result = await initiate(strapi);

    expect(status).toHaveBeenCalledWith(EXISTING_TOKEN);
    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        status: "Redirected",
        redirectUrl: `https://pay.snapp.test/start?paymentToken=${EXISTING_TOKEN}`,
        transactionId: EXISTING_TRANSACTION_ID,
      }),
    );
  });

  it("does not revert or retarget a stale REGISTERED token", async () => {
    const requestPaymentToken = jest.fn();
    const revert = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue(providerResult({ response: { status: "REGISTERED" } })),
      revert,
      requestPaymentToken,
    } as any);
    const { strapi } = createHarness({
      redirectedAt: new Date(Date.now() - 3 * 60 * 1000),
    });

    const result = await initiate(strapi);

    expect(revert).not.toHaveBeenCalled();
    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.redirectUrl).toContain(EXISTING_TOKEN);
  });

  it("does not mint a replacement token for parsed 1007 without an OK callback", async () => {
    const revert = jest.fn();
    const requestPaymentToken = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue({
        successful: false,
        diagnostic: { endpoint: "status", httpStatus: 404, providerCode: 1007 },
      }),
      revert,
      requestPaymentToken,
    } as any);
    const { strapi } = createHarness({
      redirectedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const result = await initiate(strapi);

    expect(revert).not.toHaveBeenCalled();
    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: "Unknown",
        errorCode: "PAYMENT_UNKNOWN",
      }),
    );
  });

  it("does not mint a replacement token for parsed 1048", async () => {
    const requestPaymentToken = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue({
        successful: false,
        diagnostic: { endpoint: "status", httpStatus: 400, providerCode: 1048 },
      }),
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi } = createHarness();

    const result = await initiate(strapi);

    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result.errorCode).toBe("PAYMENT_UNKNOWN");
  });

  it("recovers OK-callback plus 1007 through verify instead of a new token", async () => {
    const requestPaymentToken = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue({
        successful: false,
        diagnostic: { endpoint: "status", httpStatus: 404, providerCode: 1007 },
      }),
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi } = createHarness({
      providerStatus: "CALLBACK_OK",
      nextAction: "verify",
    });

    const result = await initiate(strapi);

    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.redirectUrl).toContain("/payment/result");
  });

  it("recovers PENDING plus a validated OK callback through verify", async () => {
    const requestPaymentToken = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue(providerResult({ response: { status: "PENDING" } })),
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi } = createHarness({
      providerStatus: "CALLBACK_OK",
      nextAction: "verify",
    });

    const result = await initiate(strapi);

    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result.redirectUrl).toContain("/payment/result");
  });

  it("does not fulfill a status payload bound to another transaction id", async () => {
    const requestPaymentToken = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue(
        providerResult({
          response: { status: "SETTLE", transactionId: "ZZZZZZZZZZ", amount: 2_200_000 },
        }),
      ),
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi } = createHarness();

    const result = await initiate(strapi);

    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        errorCode: "PAYMENT_UNKNOWN",
      }),
    );
  });

  it("fulfills verify/settle without minting a second token", async () => {
    const requestPaymentToken = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue(providerResult({ response: { status: "VERIFY" } })),
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi } = createHarness();

    const result = await initiate(strapi);

    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.redirectUrl).toContain("/payment/result");
  });

  it("does not mint a token when status times out", async () => {
    const requestPaymentToken = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn().mockResolvedValue({
        successful: false,
        diagnostic: {
          endpoint: "status",
          timedOut: true,
          transportError: false,
        },
      }),
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi } = createHarness();

    const result = await initiate(strapi);

    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: "Unknown",
        errorCode: "PAYMENT_UNKNOWN",
      }),
    );
  });

  it("persists the candidate generation before POST /token and does not post if persist fails", async () => {
    const requestPaymentToken = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn(),
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi, queries, transaction } = createHarness({
      Status: "Pending",
      redirectUrl: "",
      redirectedAt: null,
      providerResponse: { tokenAttemptSeq: 0 },
    });
    transaction.TrackId = "";
    strapi.db.query("api::payment-attempt.payment-attempt");
    queries["api::payment-attempt.payment-attempt"].update.mockImplementation(async (args: { data?: { providerResponse?: { pendingDispatch?: unknown } } }) => {
      if (args?.data?.providerResponse?.pendingDispatch) {
        throw new Error("persist failed");
      }
      return { id: 1 };
    });

    const result = await initiate(strapi);

    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result.errorCode).toBe("PAYMENT_UNKNOWN");
  });

  it("persists pendingDispatch then posts exactly one token for the first generation", async () => {
    const requestPaymentToken = jest.fn().mockResolvedValue({
      successful: true,
      response: {
        paymentToken: "new-token",
        paymentPageUrl: "https://pay.snapp.test/new",
      },
      diagnostic: { endpoint: "token", httpStatus: 200 },
    });
    mockedAdapter.mockReturnValue({
      status: jest.fn(),
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi, queries, transaction } = createHarness({
      Status: "Pending",
      redirectUrl: "",
      redirectedAt: null,
      providerResponse: { tokenAttemptSeq: 0 },
    });
    transaction.TrackId = "";

    const result = await initiate(strapi);

    const pendingWrites = queries["api::payment-attempt.payment-attempt"].update.mock.calls.filter(
      (call: [{ data?: { providerResponse?: { pendingDispatch?: { seq?: number } } } }]) =>
        Number(call[0]?.data?.providerResponse?.pendingDispatch?.seq) === 1,
    );
    expect(pendingWrites.length).toBeGreaterThan(0);
    expect(requestPaymentToken).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.redirectUrl).toBe("https://pay.snapp.test/new");
  });

  it("does not mint a second token when a dispatch is already in flight", async () => {
    const requestPaymentToken = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn(),
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi, transaction } = createHarness({
      Status: "Pending",
      redirectUrl: "",
      redirectedAt: null,
      providerResponse: {
        tokenAttemptSeq: 1,
        pendingDispatch: {
          seq: 1,
          transactionId: EXISTING_TRANSACTION_ID,
          dispatchedAt: new Date().toISOString(),
          callbackNonceHash: hashSnappayCallbackNonce(CALLBACK_NONCE),
        },
      },
    });
    transaction.TrackId = "";

    const result = await initiate(strapi);

    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result.errorCode).toBe("PAYMENT_UNKNOWN");
  });

  it("does not use a previous generation token to resolve a 1009 on the candidate", async () => {
    const requestPaymentToken = jest.fn().mockResolvedValue({
      successful: false,
      errorData: { errorCode: 1009, message: "duplicated data" },
      diagnostic: { endpoint: "token", httpStatus: 400, providerCode: 1009 },
    });
    const status = jest.fn().mockResolvedValue(providerResult({ response: { status: "REVERT" } }));
    mockedAdapter.mockReturnValue({
      status,
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi } = createHarness({
      providerStatus: "REVERT",
      providerResponse: {
        tokenAttemptSeq: 1,
        tokenFingerprint: displaySnappayFingerprint(snappayTokenFingerprint(EXISTING_TOKEN)),
        generation: {
          seq: 1,
          transactionId: EXISTING_TRANSACTION_ID,
          dispatchedAt: new Date().toISOString(),
          paymentToken: EXISTING_TOKEN,
          paymentTokenFingerprint: displaySnappayFingerprint(snappayTokenFingerprint(EXISTING_TOKEN)),
          terminalEvidence: "REVERT",
        },
      },
    });

    const result = await initiate(strapi);

    expect(status).toHaveBeenCalledTimes(1);
    expect(requestPaymentToken).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        errorCode: "SNAPPAY_TOKEN_DUPLICATE",
      }),
    );
  });

  it("resolves token 1009 without posting a third transaction id when this generation has no token", async () => {
    const requestPaymentToken = jest.fn().mockResolvedValue({
      successful: false,
      errorData: { errorCode: 1009, message: "duplicated data" },
      diagnostic: { endpoint: "token", httpStatus: 400, providerCode: 1009 },
    });
    const status = jest.fn().mockResolvedValue(providerResult({ response: { status: "PENDING" } }));
    mockedAdapter.mockReturnValue({
      status,
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi, transaction } = createHarness({
      Status: "Pending",
      redirectUrl: "",
      redirectedAt: null,
      providerResponse: { tokenAttemptSeq: 0 },
    });
    transaction.TrackId = "";

    const result = await initiate(strapi);

    expect(requestPaymentToken).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        errorCode: "SNAPPAY_TOKEN_DUPLICATE",
      }),
    );
  });

  it("does not mint a second token when two tabs race the initiation lease", async () => {
    const requestPaymentToken = jest.fn();
    mockedAdapter.mockReturnValue({
      status: jest.fn(),
      requestPaymentToken,
      revert: jest.fn(),
    } as any);
    const { strapi } = createHarness();
    strapi.db.connection.raw.mockResolvedValue({ rows: [] });

    const result = await initiate(strapi);

    expect(requestPaymentToken).not.toHaveBeenCalled();
    expect(result.errorCode).toBe("PAYMENT_IN_PROGRESS");
  });
});
