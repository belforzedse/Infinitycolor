import { render, screen, waitFor } from "@testing-library/react";
import ProductActivityLogs from "../ProductActivityLogs";
import { getProductAdminActivities } from "@/services/admin-activity";
import { useCurrentUser } from "@/hooks/useCurrentUser";

jest.mock("@/services/admin-activity", () => ({
  getOrderAdminActivities: jest.fn(),
  getProductAdminActivities: jest.fn(),
}));

jest.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: jest.fn(),
}));

const mockGetProductAdminActivities =
  getProductAdminActivities as jest.MockedFunction<typeof getProductAdminActivities>;
const mockUseCurrentUser = useCurrentUser as jest.MockedFunction<typeof useCurrentUser>;

const currentUser = ({
  roleName,
  isLoading = false,
}: {
  roleName?: string | null;
  isLoading?: boolean;
}) => ({
  user: roleName ? ({ id: 1, roleName } as any) : null,
  isLoading,
  error: null,
  isAuthenticated: Boolean(roleName),
  isAdmin: roleName === "Superadmin",
  roleName: roleName ?? null,
  isStoreManager: roleName === "Store manager",
  isFounder: roleName === "Founder",
});

describe("ProductActivityLogs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetProductAdminActivities.mockResolvedValue({ data: [] });
  });

  it("does not render or request product activities for store managers", () => {
    mockUseCurrentUser.mockReturnValue(currentUser({ roleName: "Store manager" }));

    render(<ProductActivityLogs productId={123} title="Product events" pageSize={20} />);

    expect(screen.queryByText("Product events")).not.toBeInTheDocument();
    expect(mockGetProductAdminActivities).not.toHaveBeenCalled();
  });

  it("does not render or request product activities for founders", () => {
    mockUseCurrentUser.mockReturnValue(currentUser({ roleName: "Founder" }));

    render(<ProductActivityLogs productId={123} title="Product events" pageSize={20} />);

    expect(screen.queryByText("Product events")).not.toBeInTheDocument();
    expect(mockGetProductAdminActivities).not.toHaveBeenCalled();
  });

  it("renders and requests product activities for superadmins", async () => {
    mockUseCurrentUser.mockReturnValue(currentUser({ roleName: "Superadmin" }));

    render(<ProductActivityLogs productId={123} title="Product events" pageSize={20} />);

    expect(screen.getByText("Product events")).toBeInTheDocument();

    await waitFor(() => {
      expect(mockGetProductAdminActivities).toHaveBeenCalledWith(123, { pageSize: 20 });
    });
  });

  it("does not request product activities while user state is loading", () => {
    mockUseCurrentUser.mockReturnValue(
      currentUser({ roleName: "Superadmin", isLoading: true }),
    );

    render(<ProductActivityLogs productId={123} title="Product events" pageSize={20} />);

    expect(screen.queryByText("Product events")).not.toBeInTheDocument();
    expect(mockGetProductAdminActivities).not.toHaveBeenCalled();
  });

  it("does not request product activities without a user", () => {
    mockUseCurrentUser.mockReturnValue(currentUser({ roleName: null }));

    render(<ProductActivityLogs productId={123} title="Product events" pageSize={20} />);

    expect(screen.queryByText("Product events")).not.toBeInTheDocument();
    expect(mockGetProductAdminActivities).not.toHaveBeenCalled();
  });
});
