import { resolveProductReviewUserDisplayName } from "../productReviewAuthorName";

describe("resolveProductReviewUserDisplayName", () => {
  it("prefers the profile name", () => {
    expect(
      resolveProductReviewUserDisplayName({
        id: 1,
        username: "+989121234567",
        user_info: { FirstName: "علی", LastName: "رضایی" },
      }),
    ).toBe("علی رضایی");
  });

  it("uses the canonical phone field when the profile is empty", () => {
    expect(
      resolveProductReviewUserDisplayName({
        id: 2,
        phone: "+989121234567",
      }),
    ).toBe("+989121234567");
  });

  it("does not require the legacy Phone attribute", () => {
    expect(
      resolveProductReviewUserDisplayName({
        id: 3,
        Phone: undefined,
        phone: "09120000000",
      }),
    ).toBe("09120000000");
  });
});
