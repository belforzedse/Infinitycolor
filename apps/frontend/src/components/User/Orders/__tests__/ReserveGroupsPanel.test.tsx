import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReserveGroupsPanel from "../ReserveGroupsPanel";
import OrderService from "@/services/order";

jest.mock("@/services/order", () => ({
  __esModule: true,
  default: {
    getMyReserveGroups: jest.fn(),
    releaseReserve: jest.fn(),
  },
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

const group = (overrides: Record<string, unknown> = {}) => ({
  reserveGroupId: "grp-1",
  state: "Active",
  closureReason: null,
  expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
  activatedAt: new Date().toISOString(),
  closedAt: null,
  lastOrderAttachedAt: null,
  lastActivityAt: new Date().toISOString(),
  orderCount: 2,
  shippingCostPaid: 20_000,
  shippingMethodTitle: "پست پیشتاز",
  destination: "تهران، خیابان آزادی",
  rootOrderId: 41,
  shippingBarcode: null,
  isActive: true,
  ...overrides,
});

describe("ReserveGroupsPanel", () => {
  beforeEach(() => jest.clearAllMocks());

  it("keeps closed groups in the history and states why each one closed", async () => {
    (OrderService.getMyReserveGroups as jest.Mock).mockResolvedValue({
      data: [
        group(),
        group({
          reserveGroupId: "grp-0",
          state: "Completed",
          closureReason: "Expired",
          isActive: false,
          closedAt: new Date(Date.now() - 72 * 3_600_000).toISOString(),
          shippingBarcode: "ANP-9",
        }),
      ],
    });

    render(<ReserveGroupsPanel />);

    await waitFor(() => expect(screen.getAllByTestId("reserve-group-card")).toHaveLength(2));
    expect(screen.getByText("رزرو فعال")).toBeInTheDocument();
    expect(screen.getByText("ارسال شده")).toBeInTheDocument();
    expect(screen.getByText(/ANP-9/)).toBeInTheDocument();
  });

  it("offers early release only on an open group, and only after confirmation", async () => {
    (OrderService.getMyReserveGroups as jest.Mock).mockResolvedValue({
      data: [group(), group({ reserveGroupId: "grp-0", state: "Completed", isActive: false })],
    });
    (OrderService.releaseReserve as jest.Mock).mockResolvedValue({ data: { success: true } });

    render(<ReserveGroupsPanel />);
    await waitFor(() => expect(screen.getAllByTestId("reserve-group-card")).toHaveLength(2));

    // One open group -> exactly one release affordance.
    const releaseButtons = screen.getAllByRole("button", { name: "ارسال الان" });
    expect(releaseButtons).toHaveLength(1);

    fireEvent.click(releaseButtons[0]);
    expect(OrderService.releaseReserve).not.toHaveBeenCalled();
    expect(
      screen.getByText(/پس از آن نمی‌توانید سفارش دیگری به این بسته اضافه کنید/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "بله، همین حالا ارسال شود" }));
    await waitFor(() => expect(OrderService.releaseReserve).toHaveBeenCalledWith(41));
  });

  it("explains the feature when the customer has never used it", async () => {
    (OrderService.getMyReserveGroups as jest.Mock).mockResolvedValue({ data: [] });

    render(<ReserveGroupsPanel />);

    await waitFor(() =>
      expect(screen.getByText("هنوز سفارش رزروی ثبت نکرده‌اید.")).toBeInTheDocument(),
    );
  });
});
