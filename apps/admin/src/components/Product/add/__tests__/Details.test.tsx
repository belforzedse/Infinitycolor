import { fireEvent, render, screen } from "@testing-library/react";

const setProduct = jest.fn();

jest.mock("jotai", () => ({
  ...jest.requireActual("jotai"),
  useAtom: () => [
    {
      Title: "محصول آزمایشی",
      Description: "",
      Status: "InActive",
      ProductType: "Variable",
      IsSimpleProduct: false,
      Weight: 100,
      CoverImage: null,
      Media: [],
      product_main_category: null,
      product_tags: [],
      Files: [],
      product_other_categories: [],
    },
    setProduct,
  ],
}));

jest.mock("@/components/RichTextEditor", () => ({
  __esModule: true,
  default: () => <div data-testid="rich-text-editor" />,
}));

import ProductDetails from "../Details";

describe("product details", () => {
  it("selects the complete weight when the field receives focus", () => {
    const select = jest
      .spyOn(HTMLInputElement.prototype, "select")
      .mockImplementation();

    render(<ProductDetails />);
    fireEvent.focus(screen.getByRole("spinbutton"));

    expect(select).toHaveBeenCalledTimes(1);
    select.mockRestore();
  });
});
