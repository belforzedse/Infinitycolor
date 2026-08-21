import { render, screen, waitFor } from "@testing-library/react";
import AuthenticatedUserLayout from "./AuthenticatedUserClientLayout";

const mockReplace = jest.fn();
const mockUseUser = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => "/account",
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock(
  "next/dynamic",
  () => () =>
    function MockDynamicComponent() {
      return null;
    },
);
jest.mock(
  "@/components/PLP/Footer",
  () =>
    function MockFooter() {
      return <footer />;
    },
);
jest.mock(
  "@/components/User/Header",
  () =>
    function MockHeader() {
      return <header />;
    },
);
jest.mock(
  "@/components/User/Account/ProfileCompletionBanner",
  () =>
    function MockProfileCompletionBanner() {
      return null;
    },
);
jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({ isDrawerOpen: false }),
}));
jest.mock("@/hooks/useAccountFreshData", () => ({
  useAccountFreshData: jest.fn(),
}));
jest.mock("@/hooks/useUser", () => ({
  __esModule: true,
  default: () => mockUseUser(),
}));
jest.mock("@/components/storefront", () => ({
  StorefrontContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock(
  "@/components/AdaptiveQuality/AdaptiveQualityBoundary",
  () =>
    function MockAdaptiveQualityBoundary({ children }: { children: React.ReactNode }) {
      return <>{children}</>;
    },
);

describe("AuthenticatedUserLayout", () => {
  beforeEach(() => {
    mockReplace.mockReset();
    window.history.replaceState({}, "", "/account?tab=profile");
  });

  it("never renders account content while authentication is unresolved", () => {
    mockUseUser.mockReturnValue({
      userData: null,
      isLoading: true,
      error: null,
      refetch: jest.fn(),
    });

    render(
      <AuthenticatedUserLayout>
        <div>protected account content</div>
      </AuthenticatedUserLayout>,
    );

    expect(screen.queryByText("protected account content")).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("keeps account content hidden and redirects when authentication is absent", async () => {
    mockUseUser.mockReturnValue({
      userData: null,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });

    render(
      <AuthenticatedUserLayout>
        <div>protected account content</div>
      </AuthenticatedUserLayout>,
    );

    expect(screen.queryByText("protected account content")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/auth?redirect=%2Faccount%3Ftab%3Dprofile");
    });
  });

  it("renders account content only for a resolved user", () => {
    mockUseUser.mockReturnValue({
      userData: { id: 1 },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });

    render(
      <AuthenticatedUserLayout>
        <div>protected account content</div>
      </AuthenticatedUserLayout>,
    );

    expect(screen.getByText("protected account content")).toBeVisible();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
