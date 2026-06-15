import { fireEvent, render, screen, within } from "@testing-library/react";
import PLPListFilterCategory from "../Category";
import type { ProductCategorySummary } from "@/services/product/categories";
import type { ComponentProps } from "react";

const category = (
  id: number,
  name: string,
  slug: string,
  parentId: number | null = null,
  children: ProductCategorySummary[] = [],
): ProductCategorySummary => ({
  id,
  name,
  slug,
  imageUrl: null,
  imageAlt: name,
  megaMenuImageUrl: null,
  megaMenuImageAlt: name,
  parentId,
  isMainCategory: parentId === null,
  featured: false,
  children,
});

const categories = [
  category(1, "مانتو", "coat-and-mantle", null, [category(2, "مانتو کتی", "coat-blazer", 1)]),
  category(3, "لباس رسمی", "formal-clothing", null, [category(4, "کت زنانه", "women-jacket", 3)]),
  category(5, "کیف", "bags"),
];

function renderCategoryFilter(props: Partial<ComponentProps<typeof PLPListFilterCategory>> = {}) {
  const onOptionSelect = jest.fn();
  render(
    <PLPListFilterCategory
      title="دسته بندی محصولات"
      value=""
      categories={categories}
      onOptionSelect={onOptionSelect}
      {...props}
    />,
  );

  return { onOptionSelect };
}

describe("PLPListFilterCategory", () => {
  it("renders mobile bucket groups before unmatched parent and fallback groups", () => {
    renderCategoryFilter();

    fireEvent.click(screen.getByRole("button", { name: "انتخاب دسته بندی" }));

    const upperBodyButton = screen.getByRole("button", { name: "بالاتنه" });
    const parentButton = screen.getByRole("button", { name: "لباس رسمی" });
    const otherButton = screen.getByRole("button", { name: "سایر" });

    expect(
      upperBodyButton.compareDocumentPosition(parentButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      parentButton.compareDocumentPosition(otherButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("expands and collapses category groups as an accordion section", () => {
    renderCategoryFilter();

    fireEvent.click(screen.getByRole("button", { name: "انتخاب دسته بندی" }));

    const parentButton = screen.getByRole("button", { name: "لباس رسمی" });
    expect(parentButton).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(parentButton);

    expect(parentButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: "کت زنانه" })).toBeInTheDocument();
  });

  it("selects parent and child categories by slug", () => {
    const { onOptionSelect } = renderCategoryFilter();

    fireEvent.click(screen.getByRole("button", { name: "انتخاب دسته بندی" }));
    fireEvent.click(screen.getByRole("option", { name: "مانتو" }));

    expect(onOptionSelect).toHaveBeenLastCalledWith("coat-and-mantle");

    fireEvent.click(screen.getByRole("button", { name: "مانتو" }));
    fireEvent.click(screen.getByRole("option", { name: "مانتو کتی" }));

    expect(onOptionSelect).toHaveBeenLastCalledWith("coat-blazer");
  });

  it("searches child categories and shows group and parent context", () => {
    renderCategoryFilter();

    fireEvent.click(screen.getByRole("button", { name: "انتخاب دسته بندی" }));
    fireEvent.change(screen.getByRole("textbox", { name: "جستجوی دسته بندی" }), {
      target: { value: "کتی" },
    });

    const listbox = screen.getByRole("listbox", { name: "دسته بندی محصولات" });
    expect(within(listbox).getByRole("option", { name: /مانتو کتی/ })).toBeInTheDocument();
    expect(within(listbox).getByText("بالاتنه / مانتو")).toBeInTheDocument();
  });

  it("displays a selected child category in the trigger", () => {
    renderCategoryFilter({ value: "coat-blazer" });

    expect(screen.getByRole("button", { name: "مانتو کتی" })).toBeInTheDocument();
  });
});
