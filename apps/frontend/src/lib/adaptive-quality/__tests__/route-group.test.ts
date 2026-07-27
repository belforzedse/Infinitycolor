import { getAdaptiveRouteGroup } from "../route-group";

describe("adaptive telemetry route groups", () => {
  it.each([
    ["/", false, "home"],
    ["/plp", false, "plp"],
    ["/plp", true, "search"],
    ["/categories/shoes", true, "search"],
    ["/pdp/example", false, "pdp"],
    ["/cart", false, "cart"],
    ["/checkout/address", false, "checkout"],
    ["/payment/result", false, "checkout"],
    ["/orders/payment-callback", false, "checkout"],
    ["/orders/success", false, "checkout"],
    ["/orders", false, "account"],
    ["/auth", false, "auth"],
    ["/account", false, "account"],
    ["/blog/article", false, "blog"],
    ["/about", false, "other"],
  ] as const)("maps %s to a fixed group", (pathname, search, expected) => {
    expect(getAdaptiveRouteGroup(pathname, search)).toBe(expected);
  });
});
