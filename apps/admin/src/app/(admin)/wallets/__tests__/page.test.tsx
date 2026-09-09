import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WalletAdministrationPage from "../page";

const mockGet = jest.fn();
const mockUseCurrentUser = jest.fn(() => ({ user: { id: 99 } }));

jest.mock("@/services", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));
jest.mock("@/hooks/useCan", () => ({
  useCan: () => true,
}));
jest.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => mockUseCurrentUser(),
}));
jest.mock("@/app/(admin)/users/edit/[id]/WalletAdjustCard", () => ({
  __esModule: true,
  default: ({
    userId,
    customerName,
    customerPhone,
    allowAdjust = true,
  }: {
    userId: number;
    customerName?: string;
    customerPhone?: string | null;
    allowAdjust?: boolean;
  }) => (
    <div data-testid="wallet-adjust-card" data-allow-adjust={allowAdjust ? "true" : "false"}>
      {userId}:{customerName}:{customerPhone}
    </div>
  ),
}));
jest.mock("use-debounce", () => {
  const React = require("react") as typeof import("react");
  return {
    useDebouncedCallback: (callback: (...args: string[]) => void) => {
      const callbackRef = React.useRef(callback);
      callbackRef.current = callback;
      return React.useMemo(() => {
        const debounced = (value: string) => {
          callbackRef.current(value);
        };
        debounced.cancel = jest.fn();
        return debounced;
      }, []);
    },
  };
});

const customer = {
  id: 44,
  phone: "+989123381098",
  firstName: "سید محمد",
  lastName: "حسینی",
  isActive: true,
};

describe("wallet administration search", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: [customer] });
    mockUseCurrentUser.mockReturnValue({ user: { id: 99 } });
  });

  it("shows the selected customer name and phone after a search", async () => {
    render(<WalletAdministrationPage />);

    fireEvent.change(screen.getByTestId("wallet-customer-search"), {
      target: { value: "09123381098" },
    });
    fireEvent.submit(screen.getByTestId("wallet-customer-search").closest("form")!);

    const result = await screen.findByTestId("wallet-customer-result");
    expect(result).toHaveTextContent("سید محمد حسینی");
    expect(result).toHaveTextContent("+989123381098");

    fireEvent.click(result);

    expect(screen.getByTestId("wallet-selected-name")).toHaveTextContent("سید محمد حسینی");
    expect(screen.getByTestId("wallet-selected-phone")).toHaveTextContent("+989123381098");
    expect(screen.getByTestId("wallet-adjust-card")).toHaveTextContent(
      "44:سید محمد حسینی:+989123381098",
    );
    expect(screen.getByTestId("wallet-adjust-card")).toHaveAttribute("data-allow-adjust", "true");
    expect(result).toHaveAttribute("data-selected", "true");
  });

  it("keeps the wallet editor read-only when the selected user is the signed-in admin", async () => {
    mockUseCurrentUser.mockReturnValue({ user: { id: customer.id } });
    render(<WalletAdministrationPage />);

    fireEvent.change(screen.getByTestId("wallet-customer-search"), {
      target: { value: "09123381098" },
    });
    fireEvent.submit(screen.getByTestId("wallet-customer-search").closest("form")!);

    fireEvent.click(await screen.findByTestId("wallet-customer-result"));

    expect(screen.getByTestId("wallet-adjust-card")).toHaveAttribute("data-allow-adjust", "false");
  });

  it("renders an empty state when the API returns no customers", async () => {
    mockGet.mockResolvedValue({ data: [] });
    render(<WalletAdministrationPage />);

    fireEvent.change(screen.getByTestId("wallet-customer-search"), {
      target: { value: "ناموجود" },
    });
    fireEvent.submit(screen.getByTestId("wallet-customer-search").closest("form")!);

    expect(await screen.findByText("کاربری یافت نشد.")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith(
        "/sp/customers/search?q=%D9%86%D8%A7%D9%85%D9%88%D8%AC%D9%88%D8%AF&pageSize=20",
        { cache: "no-store" },
      );
    });
  });
});
