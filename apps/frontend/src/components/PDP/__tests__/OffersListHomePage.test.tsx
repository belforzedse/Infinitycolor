import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProductCardProps } from "@/components/Product/Card";
import OffersListHomePage from "../OffersListHomePage";

jest.mock("@/components/Product/Card", () => ({
  __esModule: true,
  default: ({ id }: { id: number }) => <div data-testid="home-product-card" data-product-id={id} />,
}));

const products = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
})) as ProductCardProps[];

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

function renderedProductIds(): string[] {
  return screen
    .getAllByTestId("home-product-card")
    .map((card) => card.getAttribute("data-product-id") || "");
}

describe("OffersListHomePage", () => {
  beforeEach(() => {
    setViewportWidth(1440);
  });

  it("keeps the responsive JavaScript card limits and paginates every product", async () => {
    render(
      <OffersListHomePage
        icon={<span aria-hidden="true" />}
        title="جدیدترین ها"
        products={products}
      />,
    );

    expect(
      screen.getAllByTestId("home-product-card")[0].parentElement?.parentElement,
    ).toHaveAttribute("data-products-per-page", "4");
    expect(renderedProductIds()).toEqual(["1", "2", "3", "4"]);

    fireEvent.click(screen.getByRole("button", { name: "صفحه بعدی محصولات" }));
    expect(renderedProductIds()).toEqual(["5", "6", "7", "8"]);

    act(() => {
      setViewportWidth(2560);
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(renderedProductIds()).toEqual(["1", "2", "3", "4", "5", "6"]);
    });
  });

  it("renders two cards on narrow screens and keeps the rest reachable", () => {
    setViewportWidth(390);
    render(
      <OffersListHomePage
        icon={<span aria-hidden="true" />}
        title="محبوب ترین ها"
        products={products}
      />,
    );

    expect(renderedProductIds()).toEqual(["1", "2"]);
    fireEvent.click(screen.getByRole("button", { name: "صفحه بعدی محصولات" }));
    expect(renderedProductIds()).toEqual(["3", "4"]);
    expect(screen.getByRole("link", { name: "مشاهده محصولات بیشتر" })).toHaveAttribute(
      "href",
      "/plp?sort=AverageRating:desc",
    );
  });
});
