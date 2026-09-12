import { fireEvent, render, screen } from "@testing-library/react";
import AccountQuickLinks from "../QuickLinks";
import { USER_SIDEBAR_ITEMS } from "@/components/User/Constnats";

const mockPerformLogout = jest.fn();

jest.mock("@/utils/logout", () => ({
  performLogout: (...args: unknown[]) => mockPerformLogout(...args),
}));

describe("AccountQuickLinks", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders every account link plus a logout action", () => {
    render(<AccountQuickLinks />);

    for (const item of USER_SIDEBAR_ITEMS) {
      expect(screen.getByText(item.text)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /خروج/ })).toBeInTheDocument();
  });

  it("asks for confirmation before logging out", () => {
    render(<AccountQuickLinks />);

    fireEvent.click(screen.getByRole("button", { name: /خروج/ }));

    expect(screen.getByText("خروج از حساب کاربری")).toBeInTheDocument();
    expect(mockPerformLogout).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "بله، خارج شو" }));
    expect(mockPerformLogout).toHaveBeenCalledTimes(1);
  });

  it("does not log out when the confirmation is dismissed", () => {
    render(<AccountQuickLinks />);

    fireEvent.click(screen.getByRole("button", { name: /خروج/ }));
    fireEvent.click(screen.getByRole("button", { name: "انصراف" }));

    expect(mockPerformLogout).not.toHaveBeenCalled();
  });
});
