import {
  baleReturnUrl,
  checkoutGrantUrl,
  parseBaleItems,
  parseInventoryLookup,
  requireBotToken,
  verifyCheckoutGrant,
} from "../lib/protocol";

const first = "6c9d2708-c0f1-4123-81e9-30bc3556c1a0";
const second = "6c9d2708-c0f1-4123-81e9-30bc3556c1a1";
const originalEnv = process.env;

beforeEach(() => {
  process.env = {
    ...originalEnv,
    BALE_BOT_API_TOKEN: "test-only-bot-token",
    BALE_CHECKOUT_GRANT_SECRET: "test-only-32-byte-minimum-grant-secret",
    FRONTEND_BASE_URL: "https://storefront.test.invalid",
    BALE_BOT_USERNAME: "@Infinitycolor_bot",
  };
});

afterEach(() => { process.env = originalEnv; });

it("binds a deterministic grant to a checkout ID and uses only the trusted storefront origin", () => {
  const link = new URL(checkoutGrantUrl(first));
  const grant = link.hash.slice(1);
  expect(link.origin).toBe("https://storefront.test.invalid");
  expect(link.search).toBe("");
  expect(grant).toHaveLength(43);
  expect(() => verifyCheckoutGrant(first, { grant })).not.toThrow();
  expect(() => verifyCheckoutGrant(second, { grant })).toThrow("Checkout not found.");
  expect(checkoutGrantUrl(first)).toBe(link.href);
  process.env.FRONTEND_BASE_URL = "https://other.test.invalid@storefront.test.invalid/";
  expect(() => checkoutGrantUrl(first)).toThrow("Checkout is temporarily unavailable.");
});

it("keeps the bot credential separate from the checkout grant and validates the Bale return path", () => {
  expect(() => requireBotToken("Bearer test-only-bot-token")).not.toThrow();
  expect(() => requireBotToken(`Bearer ${new URL(checkoutGrantUrl(first)).hash.slice(1)}`)).toThrow(
    "A valid bot credential is required.",
  );
  expect(baleReturnUrl(first)).toBe(`https://ble.ir/Infinitycolor_bot?start=${first}`);
  process.env.BALE_BOT_USERNAME = "some/path?start=fake";
  expect(baleReturnUrl(first)).toBe("https://ble.ir/");
});

it("bounds requests before queries and rejects disguised client-supplied checkout values", () => {
  expect(parseInventoryLookup({ ids: "1,2,1" })).toEqual({ ids: [1, 2] });
  expect(() => parseInventoryLookup({ ids: Array.from({ length: 51 }, (_, i) => i + 1).join(",") })).toThrow(
    "Supply between 1 and 50 ids or skus.",
  );
  expect(() => parseInventoryLookup({ ids: "2147483648" })).toThrow("Each variation ID must be a positive integer.");
  expect(() => parseBaleItems({
    items: [{ variationId: 10, quantity: 1, priceToman: 1 }],
  })).toThrow("Each item needs");
  expect(() => parseBaleItems({
    items: [{ variationId: 10, quantity: 55 }, { variationId: 10, quantity: 46 }],
  })).toThrow("Order up to 100 of each item.");
});

it("normalizes the recipient the bot collected and refuses a shipping method without an address", () => {
  const { parseBaleCheckoutRequest } = jest.requireActual("../lib/protocol");
  const items = [{ variationId: 3, quantity: 1 }];
  expect(parseBaleCheckoutRequest({
    items,
    recipient: {
      fullName: "  علی   رضایی ", phone: "۰۹۱۲ ۳۴۵ ۶۷۸۹", cityId: "12",
      postalCode: "۱۲۳۴۵-۶۷۸۹۰", address: "تهران، خیابان آزادی، پلاک ۱",
    },
    shippingMethodId: 4,
  })).toEqual({
    items,
    recipient: {
      fullName: "علی رضایی", phone: "09123456789", cityId: 12,
      postalCode: "1234567890", address: "تهران، خیابان آزادی، پلاک ۱",
    },
    shippingMethodId: 4,
  });
  expect(parseBaleCheckoutRequest({ items })).toEqual({ items, recipient: null, shippingMethodId: null });
  expect(() => parseBaleCheckoutRequest({ items, shippingMethodId: 4 })).toThrow("needs a recipient");
  expect(() => parseBaleCheckoutRequest({ items, note: "x" })).toThrow();
  expect(() => parseBaleCheckoutRequest({
    items, recipient: { fullName: "<b>x</b>", phone: "09123456789", cityId: 1, postalCode: "1234567890", address: "long enough address" },
  })).toThrow();
});
