import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AccountAccessMenu from "../AccountAccessMenu";
import { useCurrentUser } from "@/hooks/useCurrentUser";

jest.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: jest.fn(),
}));

const mockedUseCurrentUser = useCurrentUser as jest.MockedFunction<typeof useCurrentUser>;

const mockCurrentUser = (overrides: Partial<ReturnType<typeof useCurrentUser>> = {}) => {
  mockedUseCurrentUser.mockReturnValue({
    user: null,
    isLoading: false,
    error: null,
    isAuthenticated: false,
    isAdmin: false,
    roleName: null,
    isStoreManager: false,
    isFounder: false,
    ...overrides,
  });
};

const renderAccountMenu = () =>
  render(<AccountAccessMenu triggerAriaLabel="Account" triggerClassName="account-trigger" />);

describe("AccountAccessMenu", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("links logged-out users to login", () => {
    mockCurrentUser();

    renderAccountMenu();

    expect(screen.getByRole("link", { name: "Login" })).toHaveAttribute("href", "/auth/login");
  });

  it("links logged-in non-admin users to account", () => {
    mockCurrentUser({
      user: { id: 7, isAdmin: false, roleName: "Customer" } as never,
      isAuthenticated: true,
    });

    renderAccountMenu();

    expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute("href", "/account");
  });

  it("opens account and super-admin destinations for admin users", () => {
    mockCurrentUser({
      user: { id: 1, isAdmin: true, roleName: "SuperAdmin" } as never,
      isAuthenticated: true,
      isAdmin: true,
    });

    renderAccountMenu();

    fireEvent.click(screen.getByRole("button", { name: "Account" }));

    expect(screen.getByRole("menuitem", { name: "Account" })).toHaveAttribute("href", "/account");
    expect(screen.getByRole("menuitem", { name: "Super admin" })).toHaveAttribute(
      "href",
      "/super-admin",
    );
  });

  it("closes the admin widget on outside click", async () => {
    mockCurrentUser({
      user: { id: 1, isAdmin: true, roleName: "SuperAdmin" } as never,
      isAuthenticated: true,
      isAdmin: true,
    });

    renderAccountMenu();

    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByRole("menu", { name: "Account destinations" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Account destinations" })).not.toBeInTheDocument();
    });
  });

  it("closes the admin widget on Escape", async () => {
    mockCurrentUser({
      user: { id: 1, isAdmin: true, roleName: "SuperAdmin" } as never,
      isAuthenticated: true,
      isAdmin: true,
    });

    renderAccountMenu();

    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByRole("menu", { name: "Account destinations" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Account destinations" })).not.toBeInTheDocument();
    });
  });
});
