import { fireEvent, render, screen } from "@testing-library/react";
import PDPHeroInfoAction from "../Action";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const DynamicComponent = ({ open }: { open: boolean }) =>
      open ? <div data-testid="share-modal-stub" /> : null;
    return DynamicComponent;
  },
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
    isCartReady: true,
    addToCart: jest.fn(),
  }),
}));

jest.mock("@/services/product/product", () => ({
  __esModule: true,
  getAvailableStockCount: () => 1,
  hasStockForVariation: () => true,
}));

jest.mock("@/lib/analytics/matomo", () => ({
  trackMatomoEvent: jest.fn(),
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
  it("opens the share modal instead of copying immediately", () => {
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

    expect(screen.getByTestId("share-modal-stub")).toBeInTheDocument();
  });
});
