jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, extension: any) => (params: any) => extension(params),
    // The controller's import chain reaches the wallet service, which calls
    // this at module load. Only its presence matters here — nothing in these
    // specs exercises the wallet.
    createCoreService: (_uid: string, extension?: any) => (params: any) =>
      typeof extension === "function" ? extension(params) : {},
  },
}));

import { createStrapiMock, mockContext } from "../../../__tests__/mocks/factories";
import {
  isSnappayGatewayValue,
  normalizeCheckoutGatewayCode,
} from "../services/checkout-gateway-availability";

describe("SnappPay gateway normalization", () => {
  it.each([
    "snappay",
    "SnappPay",
    "SNAPPAY",
    "Snapp! Pay",
    "اسنپ‌پی",
  ])("recognizes the stored/provider variant %s", (value) => {
    expect(isSnappayGatewayValue(value)).toBe(true);
    expect(normalizeCheckoutGatewayCode(value)).toBe("snappay");
  });

  it("does not classify unrelated providers as SnappPay", () => {
    expect(isSnappayGatewayValue("Saman Kish")).toBe(false);
    expect(isSnappayGatewayValue("wallet")).toBe(false);
  });
});

describe("payment-gateway.availableGateways", () => {
  let controllerFactory: any;
  const originalEnv = process.env;

  beforeAll(async () => {
    const mod = await import("../controllers/payment-gateway");
    controllerFactory = mod.default;
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.URL;
    delete process.env.ZARINPAL_CALLBACK_URL;
    delete process.env.ZARINPAL_E2E_DETERMINISTIC;
    delete process.env.ZARINPAL_MERCHANT_ID;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns no gateways when no backend rows exist", async () => {
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([]);
    const controller = controllerFactory({ strapi });
    const ctx = mockContext({});

    await controller.availableGateways(ctx);

    expect(ctx.send).toHaveBeenCalledWith({
      data: { gateways: [], paymentCapabilities: expect.any(Object) },
    });
  });

  it("returns only explicitly active mapped gateways", async () => {
    process.env.SAMAN_TERMINAL_ID = "terminal";
    process.env.SAMAN_USERNAME = "username";
    process.env.SAMAN_PASSWORD = "password";
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([
      { Title: "SnappPay", IsActive: false },
      { Title: "Saman Kish", IsActive: true },
      { Title: "Wallet", IsActive: true },
    ]);
    const controller = controllerFactory({ strapi });
    const ctx = mockContext({});

    await controller.availableGateways(ctx);

    expect(ctx.send).toHaveBeenCalledWith({
      data: {
        gateways: [
          expect.objectContaining({ code: "samankish" }),
          expect.objectContaining({ code: "wallet" }),
        ],
        paymentCapabilities: expect.any(Object),
      },
    });
  });

  it("keeps an active gateway hidden when its server credentials are incomplete", async () => {
    delete process.env.SAMAN_TERMINAL_ID;
    delete process.env.SAMAN_USERNAME;
    delete process.env.SAMAN_PASSWORD;
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([
      { Code: "samankish", Title: "سامان‌کیش", IsActive: true },
      { Code: "wallet", Title: "کیف پول", IsActive: true },
    ]);
    const controller = controllerFactory({ strapi });
    const ctx = mockContext({});

    await controller.availableGateways(ctx);

    expect(ctx.send).toHaveBeenCalledWith({
      data: {
        gateways: [expect.objectContaining({ code: "wallet" })],
        paymentCapabilities: expect.any(Object),
      },
    });
  });

  it("ignores unknown gateway titles", async () => {
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([
      { Title: "Unknown Gateway", IsActive: true },
      { Title: "Another Gateway", IsActive: true },
    ]);
    const controller = controllerFactory({ strapi });
    const ctx = mockContext({});

    await controller.availableGateways(ctx);

    expect(ctx.send).toHaveBeenCalledWith({
      data: { gateways: [], paymentCapabilities: expect.any(Object) },
    });
  });

  it("keeps ZarinPal hidden when active but not configured", async () => {
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([
      { Title: "ZarinPal", IsActive: true },
    ]);
    const controller = controllerFactory({ strapi });
    const ctx = mockContext({});

    await controller.availableGateways(ctx);

    expect(ctx.send).toHaveBeenCalledWith({
      data: { gateways: [], paymentCapabilities: expect.any(Object) },
    });
  });

  it("includes ZarinPal only when active and configured", async () => {
    // A localhost callback URL is a deployment detail, not a credential. The
    // gateway is offered on an explicit merchant id or an explicit test opt-in.
    process.env.URL = "http://localhost:1337";
    process.env.ZARINPAL_MERCHANT_ID = "merchant-id";
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([
      { Title: "ZarinPal", IsActive: true },
    ]);
    const controller = controllerFactory({ strapi });
    const ctx = mockContext({});

    await controller.availableGateways(ctx);

    expect(ctx.send).toHaveBeenCalledWith({
      data: {
        gateways: [expect.objectContaining({ code: "zarinpal" })],
        paymentCapabilities: expect.any(Object),
      },
    });
  });

  it("omits ZarinPal when it is active but has no credential and no test opt-in", async () => {
    process.env.URL = "http://localhost:1337";
    delete process.env.ZARINPAL_MERCHANT_ID;
    delete process.env.ZARINPAL_E2E_DETERMINISTIC;
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([
      { Title: "ZarinPal", IsActive: true },
    ]);
    const controller = controllerFactory({ strapi });
    const ctx = mockContext({});

    await controller.availableGateways(ctx);

    expect(ctx.send).toHaveBeenCalledWith({
      data: { gateways: [], paymentCapabilities: expect.any(Object) },
    });
  });

  it("returns no gateways when gateway rows cannot be loaded", async () => {
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockRejectedValue(new Error("db down"));
    const controller = controllerFactory({ strapi });
    const ctx = mockContext({});

    await controller.availableGateways(ctx);

    expect(ctx.send).toHaveBeenCalledWith({
      data: { gateways: [], paymentCapabilities: expect.any(Object) },
    });
  });
});
