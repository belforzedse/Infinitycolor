import { getAvailableCheckoutGateways, isCheckoutGatewayEnabled, isMellatCheckoutAllowed } from "../services/checkout-gateway-availability";

describe("Mellat rollout admission", () => {
  const originalEnv = process.env;
  const strapi: any = {
    entityService: { findMany: jest.fn(async () => [{ Title: "Mellat", IsActive: true }, { Title: "Wallet", IsActive: true }]) },
    log: { error: jest.fn() },
  };
  beforeEach(() => { process.env = { ...originalEnv }; delete process.env.MELLAT_CHECKOUT_MODE; delete process.env.MELLAT_CHECKOUT_PILOT_USER_IDS; });
  afterAll(() => { process.env = originalEnv; });

  it.each([undefined, "", "off", "typo"])("fails closed for mode %s", async (mode) => {
    if (mode !== undefined) process.env.MELLAT_CHECKOUT_MODE = mode;
    expect(isMellatCheckoutAllowed(12)).toBe(false);
    expect(await isCheckoutGatewayEnabled(strapi, "mellat", 12)).toBe(false);
    expect((await getAvailableCheckoutGateways(strapi, 12)).map((g) => g.code)).toEqual(["wallet"]);
  });

  it("restricts discovery and direct checkout to exact pilot customer IDs", async () => {
    process.env.MELLAT_CHECKOUT_MODE = "pilot";
    process.env.MELLAT_CHECKOUT_PILOT_USER_IDS = "12, 23, invalid, 0";
    expect(isMellatCheckoutAllowed()).toBe(false);
    expect(isMellatCheckoutAllowed(2)).toBe(false);
    expect(await isCheckoutGatewayEnabled(strapi, "mellat", 12)).toBe(true);
    expect(await isCheckoutGatewayEnabled(strapi, "mellat", 23)).toBe(true);
    expect((await getAvailableCheckoutGateways(strapi, 2)).some((g) => g.code === "mellat")).toBe(false);
    expect((await getAvailableCheckoutGateways(strapi, 12)).some((g) => g.code === "mellat")).toBe(true);
  });

  it("still requires configured credentials and an active gateway in live mode", async () => {
    process.env.MELLAT_CHECKOUT_MODE = "live";
    delete process.env.MELLAT_PASSWORD;
    expect(await isCheckoutGatewayEnabled(strapi, "mellat", 12)).toBe(false);
    expect(await isCheckoutGatewayEnabled(strapi, "wallet", 12)).toBe(true);
  });
});
