import { render, screen, within } from "@testing-library/react";
import DesktopMegaMenu from "../DesktopMegaMenu";
import type { ProductCategorySummary } from "@/services/product/categories";
import type { StorefrontMenuTaxonomyItem } from "@/utils/storefrontMenuTaxonomy";

const category = (id: number, name: string): ProductCategorySummary => ({
  id,
  name,
  slug: `category-${id}`,
  imageUrl: null,
  imageAlt: name,
  megaMenuImageUrl: null,
  megaMenuImageAlt: name,
  parentId: null,
  isMainCategory: true,
  featured: false,
  children: [],
});

describe("DesktopMegaMenu column layout", () => {
  it.each([
    { label: "one grouped category", count: 1, columns: "grid-cols-1" },
    { label: "multiple grouped categories", count: 3, columns: "grid-cols-3" },
  ])("uses the intended column layout for $label", ({ count, columns }) => {
    const categories = [category(1, "شومیز"), category(2, "پیراهن"), category(3, "پلیور")].slice(
      0,
      count,
    );
    render(
      <DesktopMegaMenu item={{ type: "group", key: "fixture", label: "بالا تنه", categories }} />,
    );

    const links = screen.getByTestId("desktop-mega-menu-links");
    expect(within(links).getAllByRole("link")).toHaveLength(count);
    // A second grid-template utility can override the intended column count
    // regardless of class order in the DOM.
    expect([...links.classList].filter((value) => value.startsWith("grid-cols-"))).toEqual([
      columns,
    ]);
  });

  it.each([
    { label: "only view-all", children: [], columns: "grid-cols-1" },
    { label: "view-all and a child", children: [category(2, "شال نخی")], columns: "grid-cols-3" },
  ])("counts the category view-all destination for $label", ({ children, columns }) => {
    const item: StorefrontMenuTaxonomyItem<ProductCategorySummary> = {
      type: "category",
      key: "fixture-category",
      category: { ...category(1, "شال"), children },
    };
    render(<DesktopMegaMenu item={item} />);

    const links = screen.getByTestId("desktop-mega-menu-links");
    expect(within(links).getAllByRole("link")).toHaveLength(children.length + 1);
    expect([...links.classList].filter((value) => value.startsWith("grid-cols-"))).toEqual([
      columns,
    ]);
  });
});
