import {
  resolveProductReviewDisplayName,
  resolveProductReviewUserDisplayName,
} from "../productReviewAuthorName";

describe("resolveProductReviewDisplayName", () => {
  it("prefers the server-resolved name when the user relation was stripped", () => {
    expect(resolveProductReviewDisplayName({ authorDisplayName: "کیمبرلی نوروزی" })).toBe(
      "کیمبرلی نوروزی",
    );
  });

  it("falls back to the user relation when the API sent no name", () => {
    const user = { id: 5, user_info: { FirstName: "یزدان", LastName: "نادری" } };
    expect(resolveProductReviewDisplayName({ user })).toBe("یزدان نادری");
    expect(resolveProductReviewDisplayName({ authorDisplayName: "  ", user })).toBe("یزدان نادری");
  });

  it("reports an anonymous author when neither source names one", () => {
    expect(resolveProductReviewDisplayName({})).toBe("کاربر ناشناس");
    expect(resolveProductReviewDisplayName()).toBe("کاربر ناشناس");
  });
});

describe("resolveProductReviewUserDisplayName", () => {
  it("masks the middle of a phone number used as a name", () => {
    expect(resolveProductReviewUserDisplayName({ id: 5, Phone: "09123456789" })).toBe(
      "0912***6789",
    );
  });
});
