import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DeliveryAddressCard from "./DeliveryAddressCard";
import type { SuperAdminOrderDetail } from "@/types/super-admin/order";
import toast from "react-hot-toast";
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));
const order = {
  recipientName: "گیرنده سفارش",
  recipientPhone: "09120000000",
  shippingProvinceTitle: "تهران",
  shippingCityTitle: "تهران",
  addressLine: "خیابان اصلی\nپلاک ۱۲",
  postalCode: "0123456789",
} as SuperAdminOrderDetail;
describe("delivery address card", () => {
  it("shows the delivery facts with readable LTR phone/postal codes and copies the full address", async () => {
    const copy = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    render(
      <DeliveryAddressCard order={order} canEdit={false} onEdit={jest.fn()} />,
    );
    expect(screen.getByRole("region", { name: "آدرس ارسال" })).toHaveAttribute(
      "dir",
      "rtl",
    );
    expect(screen.getByText("0123456789")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("09120000000")).toHaveAttribute("dir", "ltr");
    expect(screen.queryByText("ویرایش اطلاعات گیرنده")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "کپی آدرس" }));
    await waitFor(() =>
      expect(copy).toHaveBeenCalledWith(
        "گیرنده سفارش\n09120000000\nتهران، تهران\nخیابان اصلی\nپلاک ۱۲\nکد پستی: 0123456789",
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("آدرس کپی شد");
  });
  it("keeps the existing edit permission and handles missing addresses", () => {
    const edit = jest.fn();
    render(
      <DeliveryAddressCard
        order={{} as SuperAdminOrderDetail}
        canEdit
        onEdit={edit}
      />,
    );
    expect(screen.getByText("آدرس ارسال ثبت نشده است")).toBeInTheDocument();
    expect(screen.queryByText("کپی آدرس")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("ویرایش اطلاعات گیرنده"));
    expect(edit).toHaveBeenCalledTimes(1);
  });
});
