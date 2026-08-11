import { isReplayAllowedUrl, replaySampleRate } from "./sentry-replay-privacy";

describe("isReplayAllowedUrl", () => {
  it.each([
    "/",
    "/about",
    "/blog",
    "/blog/how-to-choose",
    "/categories",
    "/contact",
    "/faq",
    "/pdp/example-product",
    "/plp",
    "/plp/category/rings?sort=newest",
  ])("allows public storefront route %s", (url) => {
    expect(isReplayAllowedUrl(url)).toBe(true);
  });

  it.each([
    "/auth/login",
    "/account",
    "/addresses",
    "/cart",
    "/checkout",
    "/favorites",
    "/orders",
    "/orders/payment-callback?Authority=secret",
    "/password",
    "/payment/result",
    "/privileges",
    "/super-admin",
    "/wallet",
    "/unknown-route",
    "not a valid url %",
  ])("denies sensitive or unknown route %s", (url) => {
    expect(isReplayAllowedUrl(url)).toBe(false);
  });

  it("does not confuse a similarly prefixed route for an allowed route", () => {
    expect(isReplayAllowedUrl("/blog-admin")).toBe(false);
    expect(isReplayAllowedUrl("/pdp-private")).toBe(false);
  });
});

describe("replaySampleRate", () => {
  it("uses the fallback for absent or invalid values", () => {
    expect(replaySampleRate(undefined, 0.01)).toBe(0.01);
    expect(replaySampleRate("", 0.01)).toBe(0.01);
    expect(replaySampleRate("invalid", 1)).toBe(1);
  });

  it("accepts valid rates and clamps values to the supported range", () => {
    expect(replaySampleRate("0.25", 0)).toBe(0.25);
    expect(replaySampleRate("-1", 0.5)).toBe(0);
    expect(replaySampleRate("2", 0.5)).toBe(1);
  });
});
