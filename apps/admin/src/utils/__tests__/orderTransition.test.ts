import { describeOrderTransitionError } from "../orderTransition";

describe("describeOrderTransitionError", () => {
  it("explains a refused cancel from Returned instead of a generic 400", () => {
    expect(
      describeOrderTransitionError({
        status: 400,
        errorCode: "ORDER_CANCEL_INVALID_STATUS",
        data: { fromStatus: "Returned", error: "invalid_status" },
        message: "Order status does not allow cancellation",
      }),
    ).toContain("مرجوع");
  });

  it("asks for a SnappPay cancel reason in Persian", () => {
    expect(
      describeOrderTransitionError({
        status: 400,
        errorCode: "SNAPPAY_OPERATOR_REASON_REQUIRED",
        data: { error: "SNAPPAY_OPERATOR_REASON_REQUIRED" },
      }),
    ).toBe("برای لغو سفارش اسنپ‌پی دلیل لغو را وارد کنید.");
  });

  it("names an active SnappPay operator operation", () => {
    expect(
      describeOrderTransitionError({
        status: 409,
        errorCode: "SNAPPAY_OPERATOR_OPERATION_ACTIVE",
        data: { error: "SNAPPAY_OPERATOR_OPERATION_ACTIVE" },
      }),
    ).toContain("در حال انجام");
  });
});
