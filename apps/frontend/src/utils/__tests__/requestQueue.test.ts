import { RequestQueue } from "../requestQueue";

describe("RequestQueue", () => {
  it("preserves structured API errors for the caller", async () => {
    const queue = new RequestQueue();
    const apiError = {
      message: "Insufficient stock",
      status: 400,
      errorCode: "CART_STOCK_EXCEEDED",
    };

    await expect(queue.enqueue(async () => Promise.reject(apiError))).rejects.toBe(apiError);
  });
});
