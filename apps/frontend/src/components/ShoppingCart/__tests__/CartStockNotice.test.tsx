import { fireEvent, render, screen } from "@testing-library/react";
import CartStockNotice from "../CartStockNotice";
import { CART_STOCK_NOTICE_MESSAGE } from "@/utils/cartStock";

const dismissStockNotice = jest.fn();
let stockNotice: { adjustedCartItemIds: string[]; removedNames: string[] } | null = null;

jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({ stockNotice, dismissStockNotice }),
}));

describe("CartStockNotice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stockNotice = null;
  });

  it("renders nothing when the server has not changed the cart", () => {
    const { container } = render(<CartStockNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it("explains a quantity correction without naming every line", () => {
    stockNotice = { adjustedCartItemIds: ["12"], removedNames: [] };
    render(<CartStockNotice />);
    expect(screen.getByTestId("cart-stock-notice")).toHaveTextContent(CART_STOCK_NOTICE_MESSAGE);
  });

  it("names removed items, since they are no longer visible in the cart", () => {
    stockNotice = { adjustedCartItemIds: [], removedNames: ["کیف چرم"] };
    render(<CartStockNotice />);
    expect(screen.getByTestId("cart-stock-notice")).toHaveTextContent("کیف چرم");
  });

  it("can be dismissed", () => {
    stockNotice = { adjustedCartItemIds: ["12"], removedNames: [] };
    render(<CartStockNotice />);
    fireEvent.click(screen.getByTestId("cart-stock-notice-dismiss"));
    expect(dismissStockNotice).toHaveBeenCalledTimes(1);
  });
});
