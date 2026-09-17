import { render, screen } from "@testing-library/react";

const mockUseDashboardMetrics = jest.fn();
let mockAdminRole = "superadmin";
let mockCapabilities = ["order.read", "system.users.manage"];

jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/hooks/api/useMe", () => ({
  useMe: () => ({
    data: { FirstName: "Admin", LastName: "Operator" },
    isLoading: false,
    error: null,
  }),
}));
jest.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({
    adminRole: mockAdminRole,
    capabilities: mockCapabilities,
    isLoading: false,
  }),
}));
jest.mock("@/hooks/useDashboardMetrics", () => ({
  useDashboardMetrics: (options: unknown) => mockUseDashboardMetrics(options),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
}));

import SuperAdminPage from "../page";

describe("admin dashboard loading", () => {
  beforeEach(() => {
    mockAdminRole = "superadmin";
    mockCapabilities = ["order.read", "system.users.manage"];
    mockUseDashboardMetrics.mockReset().mockReturnValue({
      metrics: [],
      latestOrders: [],
      latestOrdersAmount: 0,
      todayOrderCounts: {
        all: 12,
        paying: 2,
        inprogress: 4,
        completed: 5,
        shipped: 3,
        cancelled: 1,
      },
      activeReserveGroups: 3,
      loading: false,
      error: undefined,
    });
  });

  it("loads the bounded summary once the authorized role is available", () => {
    render(<SuperAdminPage />);

    expect(mockUseDashboardMetrics).toHaveBeenCalledWith({
      enabled: true,
      includeUserMetric: true,
    });
  });

  it("renders today-order cards and the separate active-reserve link for order readers", () => {
    render(<SuperAdminPage />);

    expect(screen.getByRole("heading", { name: "سفارش‌های امروز" })).toBeInTheDocument();
    expect(screen.getByText("کل سفارش‌های امروز")).toBeInTheDocument();
    expect(screen.getByText("ارسال شده")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /رزروهای فعال ۳/ })).toHaveAttribute(
      "href",
      "/orders/reserve",
    );
  });

  it.each(["seller2", "store_manager"])(
    "shows aggregate cards including ارسال شده for %s through order.read",
    (role) => {
      mockAdminRole = role;
      mockCapabilities = ["order.read"];

      render(<SuperAdminPage />);

      expect(
        screen.getByRole("heading", { name: "سفارش‌های امروز" }),
      ).toBeInTheDocument();
      expect(screen.getByText("ارسال شده")).toBeInTheDocument();
      expect(mockUseDashboardMetrics).toHaveBeenCalledWith({
        enabled: true,
        includeUserMetric: false,
      });
    },
  );

  it("keeps Seller 1's dashboard free of order and reserve aggregates", () => {
    mockAdminRole = "seller1";
    mockCapabilities = ["product.read"];
    render(<SuperAdminPage />);

    expect(screen.queryByRole("heading", { name: "سفارش‌های امروز" })).not.toBeInTheDocument();
    expect(screen.queryByText("ارسال شده")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /رزروهای فعال/ })).not.toBeInTheDocument();
    expect(mockUseDashboardMetrics).toHaveBeenCalledWith({
      enabled: true,
      includeUserMetric: false,
    });
  });
});
