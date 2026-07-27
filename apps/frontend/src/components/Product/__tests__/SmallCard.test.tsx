import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import ProductSmallCard, { type ProductSmallCardProps } from "../SmallCard";

const mockNoteEnhancementLoaded = jest.fn();

jest.mock("@/lib/adaptive-quality", () => ({
  noteEnhancementLoaded: (...args: unknown[]) => mockNoteEnhancementLoaded(...args),
}));

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const DynamicComponent = () => null;
    DynamicComponent.preload = jest.fn();
    return DynamicComponent;
  },
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({
    alt = "",
    src = "",
    fill,
    loader,
    blurDataURL,
    placeholder,
    priority,
    quality,
    sizes,
    ...props
  }: {
    alt?: string;
    src?: string;
    fill?: boolean;
    loader?: unknown;
    blurDataURL?: string;
    placeholder?: string;
    priority?: boolean;
    quality?: number;
    sizes?: string;
  }) => {
    void fill;
    void loader;
    void blurDataURL;
    void placeholder;
    void priority;
    void quality;
    void sizes;

    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img alt={alt} src={src} {...props} />
    );
  },
}));

jest.mock("@/hooks/useProductLike", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    isLiked: false,
    isLoading: false,
    toggleLike: jest.fn(),
  })),
}));

jest.mock("../QuickViewModal", () => ({
  __esModule: true,
  default: ({ isOpen }: { isOpen: boolean; [key: string]: unknown }) =>
    isOpen ? <div data-testid="quick-view-modal-stub" /> : null,
  preloadQuickViewProduct: jest.fn(),
}));

jest.mock("../ShareModal", () => ({
  __esModule: true,
  default: ({ open }: { open: boolean; [key: string]: unknown }) =>
    open ? <div data-testid="share-modal-stub" /> : null,
}));

const baseProps: ProductSmallCardProps = {
  id: 42,
  slug: "e2e-small-card",
  title: "E2E Small Card",
  category: "E2E Category",
  likedCount: 0,
  price: 500_000,
  image: "/uploads/e2e.webp",
  isAvailable: true,
};

describe("ProductSmallCard", () => {
  it("keeps menu controls outside the PDP link while preserving link navigation", () => {
    render(<ProductSmallCard {...baseProps} />);

    const card = screen.getByTestId("product-small-card");
    const productLink = within(card).getByTestId("product-card-link");

    expect(productLink).toHaveAttribute("href", "/pdp/e2e-small-card");
    expect(within(productLink).queryByTestId("product-small-card-menu")).not.toBeInTheDocument();
    expect(within(card).getByTestId("product-small-card-menu")).toBeInTheDocument();
  });

  it("loads Quick View and Share after explicit menu actions", async () => {
    render(<ProductSmallCard {...baseProps} />);

    const card = screen.getByTestId("product-small-card");
    fireEvent.click(within(card).getByTestId("product-small-card-menu"));
    fireEvent.click(within(card).getByTestId("product-small-card-quick-view"));

    expect(await within(card).findByTestId("quick-view-modal-stub")).toBeInTheDocument();

    fireEvent.click(within(card).getByTestId("product-small-card-menu"));
    fireEvent.click(within(card).getByRole("menuitem", { name: "اشتراک‌گذاری" }));

    expect(await within(card).findByTestId("share-modal-stub")).toBeInTheDocument();
    expect(mockNoteEnhancementLoaded).toHaveBeenCalledWith("quick-view");
    expect(mockNoteEnhancementLoaded).toHaveBeenCalledWith("share");
  });
});
