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

  // Roles without `plugin::users-permissions.user.find` (Support is the first
  // granular one) have the real `user` relation stripped by Strapi's
  // remove-restricted-relations sanitizer. The product-review controller
  // substitutes a name-only relation so the moderation table still shows an
  // author; the phone is legitimately absent for those roles.
  it("reads the name-only relation served to roles that cannot populate users", () => {
    expect(
      resolveProductReviewUserDisplayName({
        id: null,
        user_info: {
          data: { attributes: { FirstName: "علی رضایی", LastName: null } },
        },
      } as never),
    ).toBe("علی رضایی");
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
