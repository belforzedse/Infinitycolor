import { mapProductReviewToCommentForm } from "../mapReview";

describe("mapProductReviewToCommentForm", () => {
  it("reads phone and profile name from a flattened user", () => {
    expect(
      mapProductReviewToCommentForm({
        id: 12,
        Content: "خیلی خوب",
        Status: "Need for Review",
        createdAt: "2026-09-09T10:00:00.000Z",
        updatedAt: "2026-09-09T10:00:00.000Z",
        user: {
          id: 5,
          phone: "+989121234567",
          user_info: { FirstName: "علی", LastName: "رضایی" },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        id: "12",
        message: "خیلی خوب",
        name: "علی رضایی",
        username: "+989121234567",
        status: "Need for Review",
      }),
    );
  });
});
