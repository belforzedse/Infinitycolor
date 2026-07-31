import {
  getOrderStatusCategory,
  translateOrderStatus,
} from "./statusTranslations";
import { PersianOrderStatus } from "@/constants/enums";

describe("customer order status translations", () => {
  it.each([
    ["Paying", "در انتظار پرداخت"],
    ["Started", "در حال پردازش"],
    ["Shipment", "ارسال شده"],
    ["Done", "تحویل داده شده"],
    ["Cancelled", "لغو شده"],
  ])("shows the lifecycle state %s as %s", (status, label) => {
    expect(translateOrderStatus(status)).toBe(label);
  });

  it("keeps granular shipment status in the broader in-progress tab", () => {
    expect(getOrderStatusCategory("Shipment")).toBe(PersianOrderStatus.INPROGRESS);
  });
});
