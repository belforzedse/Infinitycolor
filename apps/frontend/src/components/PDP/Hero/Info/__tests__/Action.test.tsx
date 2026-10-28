import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PDPHeroInfoAction from "../Action";

let mockCartReady = true;
let mockAuthRecoveryUnavailable = false;
const mockRetryAuthRecovery = jest.fn();
const mockAddToCart = jest.fn();

jest.mock("@/components/Product/ShareModal", () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="share-modal-stub" /> : null),
}));

jest.mock("@/hooks/useProductLike", () => ({
  __esModule: true,
  default: () => ({
    isLiked: false,
    isLoading: false,
    toggleLike: jest.fn(),
  }),
}));

jest.mock("@/hooks/useAddToCart", () => ({
  __esModule: true,
  default: () => ({
    quantity: 1,
    setQuantity: jest.fn(),
    isAdding: false,
    isInCart: false,
    isCartReady: mockCartReady,
    authRecoveryUnavailable: mockAuthRecoveryUnavailable,
    retryAuthRecovery: mockRetryAuthRecovery,
    addToCart: mockAddToCart,
  }),
}));

let mockAvailableStock = 1;

jest.mock("@/services/product/product", () => ({
  __esModule: true,
  getAvailableStockCount: () => mockAvailableStock,
  hasStockForVariation: () => true,
  LOW_STOCK_DISPLAY_THRESHOLD: 5,
}));

jest.mock("@/lib/analytics", () => ({
  trackAnalyticsEvent: jest.fn(),
}));

jest.mock("../../../Icons/ShareIcon", () => ({
  __esModule: true,
  default: () => <span data-testid="share-icon" />,
}));

jest.mock("../../../Icons/ChatIcon", () => ({
  __esModule: true,
  default: () => <span data-testid="chat-icon" />,
}));

jest.mock("../../../Icons/HeartIcon", () => ({
  __esModule: true,
  default: () => <span data-testid="heart-icon" />,
}));

jest.mock("../../../Icons/BasketIcon", () => ({
  __esModule: true,
  default: () => <span data-testid="basket-icon" />,
}));

describe("PDPHeroInfoAction", () => {
  beforeEach(() => {
    mockCartReady = true;
    mockAuthRecoveryUnavailable = false;
    jest.clearAllMocks();
  });

  it("lets the shopper recover a blocked stocked product without losing its selection", () => {
    mockCartReady = false;
    mockAuthRecoveryUnavailable = true;
    const props = {
      productId: "123",
      name: "Product",
      category: "Category",
      price: 1000,
      image: "/uploads/product.jpg",
      hasStock: true,
      variationId: "456",
      currentVariation: { id: 456, attributes: {} },
    };
    const { rerender } = render(<PDPHeroInfoAction {...props} />);
    expect(screen.getByTestId("pdp-add-to-cart")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("اتصال به سبد خرید برقرار نشد.");
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    expect(mockRetryAuthRecovery).toHaveBeenCalledTimes(1);
    expect(mockAddToCart).not.toHaveBeenCalled();

    mockCartReady = true;
    mockAuthRecoveryUnavailable = false;
    rerender(<PDPHeroInfoAction {...props} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("pdp-add-to-cart")).toBeEnabled();
    fireEvent.click(screen.getByTestId("pdp-add-to-cart"));
    expect(mockAddToCart).toHaveBeenCalledWith(1);
  });

  it("opens the share modal instead of copying immediately", async () => {
    render(
      <PDPHeroInfoAction
        productId="123"
        name="Product"
        category="Category"
        price={1000}
        image="/uploads/product.jpg"
        hasStock={false}
      />,
    );

    fireEvent.click(screen.getByTestId("share-icon").closest("button")!);

    await waitFor(() => expect(screen.getByTestId("share-modal-stub")).toBeInTheDocument());
  });

  describe("low-stock hint", () => {
    // `availableStock` is only read off a selected variation, so the hint needs
    // one; the value itself comes from the mocked getAvailableStockCount.
    const renderWithStock = (available: number) => {
      mockAvailableStock = available;
      return render(
        <PDPHeroInfoAction
          productId="123"
          name="Product"
          category="Category"
          price={1000}
          image="/uploads/product.jpg"
          hasStock
          currentVariation={{ id: 1, attributes: {} } as never}
        />,
      );
    };

    afterEach(() => {
      mockAvailableStock = 1;
    });

    it("tells the shopper how many are left at the cap", () => {
      renderWithStock(5);
      expect(screen.getByTestId("pdp-low-stock-hint")).toHaveTextContent("۵");
    });

    it("tells the shopper how many are left below the cap", () => {
      renderWithStock(2);
      expect(screen.getByTestId("pdp-low-stock-hint")).toHaveTextContent("۲");
    });

    // Above the cap the number is noise: the selector offers the same five
    // options either way, so printing it would only invite a stale count.
    it("stays quiet when stock is comfortably above the cap", () => {
      renderWithStock(40);
      expect(screen.queryByTestId("pdp-low-stock-hint")).not.toBeInTheDocument();
    });
  });
});
