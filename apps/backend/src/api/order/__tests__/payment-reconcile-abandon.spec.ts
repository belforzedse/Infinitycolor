jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, builder: any) =>
      builder({ strapi: (global as any).__reconcileAbandonStrapi }),
    createCoreService: jest.fn(() => ({})),
  },
}));

/**
 * `POST /orders/:id/payment-reconcile` with `abandon: true`.
 *
 * This is the customer-side half of reclaiming a SnappPay wallet hold. The
 * shopper always lands on the payment result page — after a FAILED callback, a
 * bare-GET return, or by navigating back themselves — so this is the one surface
 * that covers every way of leaving the provider without paying. The endpoint
 * itself only records the claim; whether anything is cancelled is decided by the
 * worker after it reads `GET /status`.
 */
describe("order.reconcilePayment with abandon", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadController(order: any, abandonOutcome: any = { accepted: true }) {
    const orderFindOne = jest.fn().mockResolvedValue(order);
    const abandonOrder = jest.fn().mockResolvedValue(abandonOutcome);
    const reconcileOrder = jest.fn().mockResolvedValue({});
    (global as any).__reconcileAbandonStrapi = {
      db: {
        query: jest.fn((uid: string) => {
          if (uid === "api::order.order") return { findOne: orderFindOne };
          return { findOne: jest.fn(), update: jest.fn() };
        }),
      },
      service: jest.fn().mockReturnValue({ abandonOrder, reconcileOrder }),
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };

    const controller = require("../controllers/order").default;
    const checkPaymentStatus = jest.fn().mockResolvedValue({ data: { success: true } });
    const call = (ctx: any) =>
      controller.reconcilePayment.call({ checkPaymentStatus }, ctx);
    return { call, orderFindOne, abandonOrder, reconcileOrder, checkPaymentStatus };
  }

  const ctxFor = (body: Record<string, unknown>) => ({
    params: { id: "60" },
    state: { user: { id: 10 } },
    request: { body },
    forbidden: jest.fn(),
    badRequest: jest.fn(),
  });

  const payingSnappayOrder = {
    id: 60,
    Status: "Paying",
    PaymentGateway: "SnappPay",
  };

  it("records the shopper's claim for their own unpaid SnappPay checkout", async () => {
    const { call, abandonOrder, reconcileOrder, checkPaymentStatus } =
      loadController(payingSnappayOrder);

    await call(ctxFor({ abandon: true }));

    expect(abandonOrder).toHaveBeenCalledWith(60, "customer_abandoned_checkout");
    expect(reconcileOrder).not.toHaveBeenCalled();
    // The response is still the ordinary payment status: the release is queued,
    // so the page keeps polling until the provider has actually answered.
    expect(checkPaymentStatus).toHaveBeenCalled();
  });

  it("reports the release only when the orchestrator recorded the claim", async () => {
    const { call, checkPaymentStatus } = loadController(payingSnappayOrder);
    checkPaymentStatus.mockResolvedValue({ data: { success: true } });

    const response: any = await call(ctxFor({ abandon: true }));

    expect(response.data.walletReleaseRequested).toBe(true);
  });

  it("tells the shopper nothing is coming when the claim was refused", async () => {
    // The orchestrator drops the claim behind the shopper's own `OK` return.
    // The page keys its confirmation on this, so a paying customer is never
    // told their credit is being released.
    const { call, abandonOrder, checkPaymentStatus } = loadController(payingSnappayOrder, {
      accepted: false,
    });
    checkPaymentStatus.mockResolvedValue({ data: { success: true } });

    const response: any = await call(ctxFor({ abandon: true }));

    expect(abandonOrder).toHaveBeenCalled();
    expect(response.data.walletReleaseRequested).toBe(false);
  });

  it("leaves the field off an ordinary reconcile", async () => {
    const { call, checkPaymentStatus } = loadController(payingSnappayOrder);
    checkPaymentStatus.mockResolvedValue({ data: { success: true } });

    const response: any = await call(ctxFor({}));

    expect(response.data.walletReleaseRequested).toBeUndefined();
  });

  it("accepts the flag as the string a form post would send", async () => {
    const { call, abandonOrder } = loadController(payingSnappayOrder);

    await call(ctxFor({ abandon: "true" }));

    expect(abandonOrder).toHaveBeenCalledWith(60, "customer_abandoned_checkout");
  });

  it("stays an ordinary reconcile without the flag", async () => {
    const { call, abandonOrder, reconcileOrder } = loadController(payingSnappayOrder);

    await call(ctxFor({}));

    expect(reconcileOrder).toHaveBeenCalledWith(60, "customer_request");
    expect(abandonOrder).not.toHaveBeenCalled();
  });

  it.each(["Started", "Shipment", "Done", "Cancelled"])(
    "refuses to unwind a %s order and falls back to a plain reconcile",
    async (Status) => {
      // A shopper can only abandon a checkout that is still trying to pay. An
      // order already carrying goods is never unwound from the storefront, and a
      // claim arriving late must not become one.
      const { call, abandonOrder, reconcileOrder } = loadController({
        ...payingSnappayOrder,
        Status,
      });

      await call(ctxFor({ abandon: true }));

      expect(abandonOrder).not.toHaveBeenCalled();
      expect(reconcileOrder).toHaveBeenCalledWith(60, "customer_request");
    },
  );

  it("ignores the flag for a gateway the orchestrator does not own", async () => {
    const { call, abandonOrder, reconcileOrder } = loadController({
      ...payingSnappayOrder,
      PaymentGateway: "Mellat",
    });

    await call(ctxFor({ abandon: true }));

    expect(abandonOrder).not.toHaveBeenCalled();
    expect(reconcileOrder).not.toHaveBeenCalled();
  });

  it("refuses an order that is not the caller's", async () => {
    const { call, orderFindOne, abandonOrder } = loadController(null);
    const ctx = ctxFor({ abandon: true });

    await call(ctx);

    // Ownership is part of the lookup, so another customer's order id simply
    // selects nothing.
    expect(orderFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 60, user: { id: 10 } } }),
    );
    expect(ctx.forbidden).toHaveBeenCalled();
    expect(abandonOrder).not.toHaveBeenCalled();
  });

  it("survives a request with no body at all", async () => {
    const { call, reconcileOrder } = loadController(payingSnappayOrder);

    await call({
      params: { id: "60" },
      state: { user: { id: 10 } },
      forbidden: jest.fn(),
      badRequest: jest.fn(),
    });

    expect(reconcileOrder).toHaveBeenCalledWith(60, "customer_request");
  });
});
