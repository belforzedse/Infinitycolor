import { render, screen, waitFor } from "@testing-library/react";
import SuperAdminOrderSidebar from "../Sidebar";
import { apiClient } from "@/services";
import { useCurrentUser } from "@/hooks/useCurrentUser";

jest.mock("@/services", () => ({
  apiClient: {
    get: jest.fn(),
  },
}));

jest.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "99" }),
  useRouter: () => ({ refresh: jest.fn() }),
}));

jest.mock("../SuperAdminOrderLogs", () => ({
  __esModule: true,
  default: () => <div data-testid="order-activity-feed" />,
}));

jest.mock("../AnipoBarcodeDialog", () => ({
  __esModule: true,
  default: () => null,
}));

const mockGet = apiClient.get as jest.MockedFunction<typeof apiClient.get>;
const mockUseCurrentUser = useCurrentUser as jest.MockedFunction<typeof useCurrentUser>;

describe("SuperAdminOrderSidebar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ data: [] } as never);
  });

  it("does not show or request order logs for store managers", () => {
    mockUseCurrentUser.mockReturnValue({
      user: { id: 7, roleName: "Store manager" } as any,
      isLoading: false,
      error: null,
      isAuthenticated: true,
      isAdmin: false,
      roleName: "Store manager",
      isStoreManager: true,
      isFounder: false,
    });

    render(<SuperAdminOrderSidebar orderData={{ id: 99 } as any} />);

    expect(screen.queryByTestId("order-activity-feed")).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("keeps the order log panel for superadmins", async () => {
    mockUseCurrentUser.mockReturnValue({
      user: { id: 1, roleName: "SuperAdmin" } as any,
      isLoading: false,
      error: null,
      isAuthenticated: true,
      isAdmin: true,
      roleName: "SuperAdmin",
      isStoreManager: false,
      isFounder: false,
    });

    render(<SuperAdminOrderSidebar orderData={{ id: 99 } as any} />);

    expect(screen.getByTestId("order-activity-feed")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith(
        "/order-logs?filters[order][id][$eq]=99&sort[0]=createdAt:desc",
      );
    });
  });
});
