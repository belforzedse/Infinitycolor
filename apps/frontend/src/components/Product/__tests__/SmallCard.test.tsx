import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import ProductSmallCard, { type ProductSmallCardProps } from "../SmallCard";

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

  it("opens the quick-view action from the sibling menu button", () => {
    render(<ProductSmallCard {...baseProps} />);

    const card = screen.getByTestId("product-small-card");
    fireEvent.click(within(card).getByTestId("product-small-card-menu"));

    expect(within(card).getByTestId("product-small-card-quick-view")).toBeVisible();
  });
});
