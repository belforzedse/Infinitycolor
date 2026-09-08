import { fireEvent, render, screen } from "@testing-library/react";
import Info from "../index";

jest.mock("../Main", () => () => null);
jest.mock("../FAQItem", () => () => null);
jest.mock("../CommentsInfo", () => () => null);
jest.mock("../useScrollToComments", () => ({ useScrollToComments: () => jest.fn() }));
jest.mock("../Price", () => ({ price }: any) => <output data-testid="price">{price}</output>);
jest.mock("../Action", () => ({ variationId, hasStock, currentVariation }: any) =>
  <button data-testid="cart" disabled={!hasStock} data-variation={variationId || ""} data-current={currentVariation?.id || ""}>cart</button>);
jest.mock("../Size", () => ({ sizes, selectedSize, onSizeChange }: any) =>
  <div>{sizes.map((s: any) => <button key={s.id} aria-pressed={selectedSize === s.id} onClick={() => onSizeChange(s.id)}>{s.title}</button>)}</div>);
jest.mock("../Color", () => ({ colors, selectedColor, onColorChange }: any) =>
  <div>{colors.map((c: any) => <button key={c.id} aria-pressed={selectedColor === c.id} onClick={() => onColorChange(c.id)}>{c.title}</button>)}</div>);
jest.mock("../Model", () => () => null);
jest.mock("../GenericAttributes", () => () => null);

const variation = (id: number, color: number, size: number, stock: number) => ({ id, attributes: {
  IsPublished: true, Price: id * 1000,
  product_variation_color: { data: { id: color } },
  product_variation_size: { data: { id: size } },
  product_stock: { data: { id, attributes: { Count: stock } } },
} });
const productData = { id: 1, attributes: { Title: "fixture", product_variations: { data: [
  variation(1, 1, 1, 2), variation(2, 2, 1, 2), variation(3, 2, 2, 2), variation(4, 1, 3, 0),
] } } } as any;
const props = {
  productId: "1", productData,
  product: { title: "fixture", description: "", cleaningInstructions: "", returnPolicy: "", price: 1000, category: "" },
  colors: [{ id: "1", title: "Code 1", colorCode: "#fff" }, { id: "2", title: "Code 2", colorCode: "#000" }],
  sizes: ["1", "2", "3"].map(id => ({ id, title: `size ${id}`, variations: [] })),
};

it("keeps the other dimension and clears stale cart identity for a nonexistent combination", () => {
  render(<Info {...props} />);
  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "1");
  fireEvent.click(screen.getByText("size 2"));
  expect(screen.getByText("Code 1")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("cart")).toBeDisabled();
  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "");
  expect(screen.getByTestId("price")).toHaveTextContent("0");
  fireEvent.click(screen.getByText("Code 2"));
  expect(screen.getByTestId("cart")).toBeEnabled();
  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "3");
});

it("preserves explicit selection across same-product refresh and reflects changed stock", () => {
  const { rerender } = render(<Info {...props} />);
  fireEvent.click(screen.getByText("Code 2"));
  fireEvent.click(screen.getByText("size 2"));
  const refreshed = JSON.parse(JSON.stringify(productData));
  refreshed.attributes.product_variations.data[2].attributes.product_stock.data.attributes.Count = 0;
  rerender(<Info {...props} productData={refreshed} />);
  expect(screen.getByText("Code 2")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("size 2")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("cart")).toBeDisabled();
  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "3");
});
