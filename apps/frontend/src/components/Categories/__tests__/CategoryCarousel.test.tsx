import { render, screen } from "@testing-library/react";
import type { ProductCategorySummary } from "@/services/product/categories";
import CategoryCarousel from "../CategoryCarousel";

jest.mock(
  "@/components/Reveal",
  () =>
    ({ children }: { children: React.ReactNode }) =>
      children,
);

jest.mock("@/components/Categories/CategoryCard", () => ({
  __esModule: true,
  default: ({ category }: { category: ProductCategorySummary }) => <div>{category.name}</div>,
}));

const categories = [
  {
    id: 1,
    name: "مانتو",
    slug: "manteau",
    imageUrl: null,
    imageAlt: "مانتو",
    megaMenuImageUrl: null,
    megaMenuImageAlt: "مانتو",
    parentId: null,
    isMainCategory: true,
  },
] satisfies ProductCategorySummary[];

describe("CategoryCarousel", () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollTo = jest.fn();
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
  });

  it("shows the homepage view-all destination when configured", () => {
    render(<CategoryCarousel categories={categories} viewAllHref="/categories" />);

    expect(screen.getByRole("heading", { name: "دسته‌بندی‌ها" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "مشاهده همه" })).toHaveAttribute("href", "/categories");
  });

  it("does not add homepage chrome to other category carousel usages", () => {
    render(<CategoryCarousel categories={categories} />);

    expect(screen.queryByRole("link", { name: "مشاهده همه" })).not.toBeInTheDocument();
  });
});
