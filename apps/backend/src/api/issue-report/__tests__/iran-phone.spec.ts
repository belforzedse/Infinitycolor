import { canonicalIranPhone, normalizeIranPhoneDigits } from "@repo/auth-core";

describe("Iran phone normalization", () => {
  it.each([
    ["۰۹۱۲ ۱۲۳ ۴۵۶۷", "+989121234567"],
    ["0912-123-4567", "+989121234567"],
    ["+98 912 123 4567", "+989121234567"],
    ["0098(912)1234567", "+989121234567"],
  ])("canonicalizes %s", (input, expected) => {
    expect(canonicalIranPhone(input)).toBe(expected);
  });

  it("rejects incomplete and non-mobile numbers", () => {
    expect(canonicalIranPhone("0912")).toBeNull();
    expect(canonicalIranPhone("02112345678")).toBeNull();
  });

  it("folds Persian and Arabic digits without retaining punctuation", () => {
    expect(normalizeIranPhoneDigits("+۹۸ (٩١٢) ۱۲۳-۴۵۶۷")).toBe("+989121234567");
  });
});
