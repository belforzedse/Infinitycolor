import { productReviewService } from "../product-review.service";
import { apiClient } from "@/services";
import { apiCache } from "@/lib/api-cache";

jest.mock("@/services", () => ({
  apiClient: { get: jest.fn(), put: jest.fn() },
}));
jest.mock("@/lib/api-cache", () => ({
  apiCache: { clearByPattern: jest.fn() },
}));

describe("productReviewService.getAllReviews", () => {
  it("maps flattened users that only expose phone", async () => {
    (apiClient.get as jest.Mock).mockResolvedValue({
      data: [
        {
          id: 8,
          Content: "عالی بود",
          Status: "Need for Review",
          Date: "2026-09-09",
          Rate: 4,
          LikeCounts: 0,
          DislikeCounts: 0,
          createdAt: "2026-09-09T10:00:00.000Z",
          updatedAt: "2026-09-09T10:00:00.000Z",
          user: { id: 3, phone: "+989121234567" },
          product: { id: 1, Title: "کیف" },
        },
      ],
      meta: { pagination: { page: 1, pageCount: 1, total: 1, pageSize: 20 } },
    });

    const result = await productReviewService.getAllReviews();

    expect(apiClient.get).toHaveBeenCalledWith(
      "/product-reviews",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(result.data[0]?.user).toEqual(
      expect.objectContaining({
        id: 3,
        Phone: "+989121234567",
        phone: "+989121234567",
      }),
    );
  });
});

describe("productReviewService.updateStatus", () => {
  it("clears the review cache after a status change", async () => {
    (apiClient.put as jest.Mock).mockResolvedValue({
      data: {
        id: 8,
        attributes: {
          Content: "عالی بود",
          Status: "Accepted",
          Date: "2026-09-09",
          Rate: 4,
          LikeCounts: 0,
          DislikeCounts: 0,
          createdAt: "2026-09-09T10:00:00.000Z",
          updatedAt: "2026-09-09T10:00:00.000Z",
        },
      },
    });

    await productReviewService.updateStatus(8, "Accepted");

    expect(apiCache.clearByPattern).toHaveBeenCalledWith(/product-reviews/i);
  });
});
