import { apiClient } from "@/services";
import {
  changeOrderStatus,
  formatSnappayOperationFailure,
  revealSnappaySupportToken,
} from "./adjustItems";

jest.mock("@/services", () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
  },
}));

describe("changeOrderStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    [1042, "مبلغ جدید سفارش اسنپ‌پی نمی‌تواند از مبلغ اولیه بیشتر باشد."],
    [
      1078,
      "این سفارش با کد تخفیف اسنپ‌پی ثبت شده و طبق ضوابط اسنپ‌پی قابل ویرایش نیست.",
    ],
    [
      1036,
      "سفارش نزد اسنپ‌پی پیدا نشد یا توکن آن نادرست است؛ درخواست را تکرار نکنید و با پشتیبانی اسنپ‌پی هماهنگ کنید.",
    ],
  ])("maps SnappPay provider code %s to an operator-readable reason", (code, message) => {
    expect(
      formatSnappayOperationFailure(
        { providerCode: code, failureMessage: null },
        "fallback",
      ),
    ).toBe(message);
  });

  it("keeps compatibility with an operation persisted before providerCode was exposed", () => {
    expect(
      formatSnappayOperationFailure(
        {
          providerCode: null,
          failureMessage: "SNAPPAY_UPDATE_1078:provider message",
        },
        "fallback",
      ),
    ).toBe(
      "این سفارش با کد تخفیف اسنپ‌پی ثبت شده و طبق ضوابط اسنپ‌پی قابل ویرایش نیست.",
    );
  });

  it("uses the guarded lifecycle endpoint for non-SnappPay orders", async () => {
    (apiClient.post as jest.Mock).mockResolvedValue({ data: { success: true } });

    await changeOrderStatus("41", "Shipment");

    expect(apiClient.post).toHaveBeenCalledWith("/orders/41/admin/transition", {
      status: "Shipment",
    });
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it("uses the guarded lifecycle endpoint for SnappPay orders too", async () => {
    (apiClient.post as jest.Mock).mockResolvedValue({ data: { success: true } });

    await changeOrderStatus("42", "Started");

    expect(apiClient.post).toHaveBeenCalledWith(
      "/orders/42/admin/transition",
      {
        status: "Started",
      },
    );
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it("reveals a SnappPay support token only through the explicit action", async () => {
    (apiClient.post as jest.Mock).mockResolvedValue({
      data: {
        paymentToken: "support-token",
        transactionId: "ABC1234567",
      },
    });

    await expect(revealSnappaySupportToken(42)).resolves.toEqual({
      paymentToken: "support-token",
      transactionId: "ABC1234567",
    });
    expect(apiClient.post).toHaveBeenCalledWith(
      "/orders/42/admin/snappay-token/reveal",
      {},
    );
  });
});
