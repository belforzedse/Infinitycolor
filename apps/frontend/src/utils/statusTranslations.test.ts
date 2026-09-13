import {
  getOrderStatusCategory,
  translateOrderStatus,
} from "./statusTranslations";
import { PersianOrderStatus } from "@/constants/enums";

describe("customer order status translations", () => {
  it.each([
    ["Paying", "در انتظار پرداخت"],
    ["Started", "در حال انجام"],
    ["Shipment", "ارسال شده"],
    // Fulfilment runs Started -> Done -> Shipment, so `Done` means the order is
    // completed/prepared. Calling it «تحویل داده شده» would tell the customer it
    // arrived while it is still waiting to be handed to the courier.
    ["Done", "تکمیل شده"],
    ["Cancelled", "لغو شده"],
  ])("shows the lifecycle state %s as %s", (status, label) => {
    expect(translateOrderStatus(status)).toBe(label);
  });

  it("treats shipment as the final bucket and completion as still in progress", () => {
    expect(getOrderStatusCategory("Shipment")).toBe(PersianOrderStatus.DELIVERED);
    expect(getOrderStatusCategory("Done")).toBe(PersianOrderStatus.INPROGRESS);
    expect(getOrderStatusCategory("Started")).toBe(PersianOrderStatus.INPROGRESS);
    expect(getOrderStatusCategory("Cancelled")).toBe(PersianOrderStatus.CANCELLED);
  });

  it("never exposes an unknown backend order status to customers", () => {
    expect(translateOrderStatus("AwaitingWarehouseRobot")).toBe("نامشخص");
  });
});
