jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, extension: any) => (params: any) => extension(params),
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

    expect(ctx.send).toHaveBeenCalledWith({ data: { gateways: [] } });
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
      data: { gateways: [expect.objectContaining({ code: "wallet" })] },
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

    expect(ctx.send).toHaveBeenCalledWith({ data: { gateways: [] } });
  });

  it("keeps ZarinPal hidden when active but not configured", async () => {
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([
      { Title: "ZarinPal", IsActive: true },
    ]);
    const controller = controllerFactory({ strapi });
    const ctx = mockContext({});

    await controller.availableGateways(ctx);

    expect(ctx.send).toHaveBeenCalledWith({ data: { gateways: [] } });
  });

  it("includes ZarinPal only when active and configured", async () => {
    process.env.URL = "http://localhost:1337";
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
      },
    });
  });

  it("returns no gateways when gateway rows cannot be loaded", async () => {
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockRejectedValue(new Error("db down"));
    const controller = controllerFactory({ strapi });
    const ctx = mockContext({});

    await controller.availableGateways(ctx);

    expect(ctx.send).toHaveBeenCalledWith({ data: { gateways: [] } });
  });
});
