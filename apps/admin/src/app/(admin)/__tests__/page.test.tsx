import { render } from "@testing-library/react";

const mockUseDashboardMetrics = jest.fn();

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
    adminRole: "superadmin",
    capabilities: ["order.read", "system.users.manage"],
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
    mockUseDashboardMetrics.mockReset().mockReturnValue({
      metrics: [],
      latestOrders: [],
      latestOrdersAmount: 0,
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
});
