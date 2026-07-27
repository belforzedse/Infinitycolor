import { safeInternalRedirect } from "../authRedirect";

describe("safeInternalRedirect", () => {
  it.each([
    ["/account", "/account"],
    ["/checkout?step=payment", "/checkout?step=payment"],
    ["/orders/123#details", "/orders/123#details"],
    ["  /wallet  ", "/wallet"],
  ])("accepts same-origin application path %s", (value, expected) => {
    expect(safeInternalRedirect(value)).toBe(expected);
  });

  it.each([
    null,
    "",
    "account",
    "https://attacker.example",
    "//attacker.example/path",
    "/\\attacker.example/path",
    "\\\\attacker.example\\path",
  ])("rejects unsafe redirect value %s", (value) => {
    expect(safeInternalRedirect(value)).toBeNull();
  });
});
