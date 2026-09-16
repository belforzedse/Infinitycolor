import { checkoutQuoteHandler } from "../controllers/handlers/checkoutQuote";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import { createCheckoutQuote } from "../services/lib/checkout-quote";
import {
  isCheckoutGatewayEnabled,
  normalizeCheckoutGatewayCode,
} from "../../payment-gateway/services/checkout-gateway-availability";

jest.mock("../../../utils/roles", () => ({
  resolveCustomerTargetUserId: jest.fn(),
}));

jest.mock("../services/lib/checkout-quote", () => ({
  createCheckoutQuote: jest.fn(),
}));

jest.mock("../../payment-gateway/services/checkout-gateway-availability", () => ({
  isCheckoutGatewayEnabled: jest.fn(),
  normalizeCheckoutGatewayCode: jest.fn((value: unknown) => value),
}));

jest.mock("../../reserve-group/lib/reserve-group", () => ({
  findAttachableGroup: jest.fn(),
  hasPaidMember: jest.fn(),
}));

const mockedResolveUserId = resolveCustomerTargetUserId as jest.Mock;
const mockedCreateQuote = createCheckoutQuote as jest.Mock;
const mockedIsGatewayEnabled = isCheckoutGatewayEnabled as jest.Mock;

// ctx.badRequest sets response state and returns -- it does not throw. (The
// rest of this handler already relies on that: SHIPPING_REQUIRED,
// ADDRESS_REQUIRED etc. all `return ctx.badRequest(...)` from inside the same
// outer try block, so a throwing mock would make every one of those look
// broken too.)
const createCtx = (body: Record<string, unknown>) => ({
  request: { body },
  badRequest: jest.fn(),
});

const createStrapiMock = (checkEligibility: jest.Mock) => ({
  service: jest.fn((uid: string) => {
    if (uid === "api::payment-gateway.snappay-orchestrator") {
      return { checkEligibility };
    }
    if (uid === "api::shipping.shipping") {
      return {
        calculateMethodForCart: jest.fn().mockResolvedValue({ price: 25_000 }),
      };
    }
    throw new Error(`Unexpected service lookup: ${uid}`);
  }),
  log: { warn: jest.fn(), error: jest.fn() },
});

describe("checkoutQuoteHandler — SnappPay eligibility failure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveUserId.mockResolvedValue(42);
    mockedIsGatewayEnabled.mockResolvedValue(true);
    mockedCreateQuote.mockResolvedValue({
      financialSummary: { total: 150_000 },
      quoteHash: "quote-hash",
    });
  });

  it("returns the quote with SnappPay flagged unavailable instead of failing the whole request", async () => {
    const checkEligibility = jest.fn().mockRejectedValue(new Error("SNAPPAY_INELIGIBLE:UNAVAILABLE"));
    const strapi = createStrapiMock(checkEligibility);
    const ctx = createCtx({
      shipping: 7,
      addressId: 9,
      gateway: "snappay",
    }) as any;

    await checkoutQuoteHandler(strapi as any)(ctx);

    // One slow gateway must not take down a checkout whose totals are already
    // computed and correct -- the shopper keeps the quote and switches gateway.
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(ctx.body).toMatchObject({
      data: {
        success: true,
        quoteHash: "quote-hash",
        gatewayAvailable: false,
        gatewayErrorCode: "SNAPPAY_UNAVAILABLE",
      },
    });
  });

  it("still succeeds the quote when SnappPay eligibility passes", async () => {
    const checkEligibility = jest.fn().mockResolvedValue(undefined);
    const strapi = createStrapiMock(checkEligibility);
    const ctx = createCtx({
      shipping: 7,
      addressId: 9,
      gateway: "snappay",
    }) as any;

    await checkoutQuoteHandler(strapi as any)(ctx);

    expect(ctx.body).toMatchObject({ data: { success: true } });
    expect(ctx.body.data.gatewayAvailable).toBeUndefined();
    expect(ctx.badRequest).not.toHaveBeenCalled();
  });
});
