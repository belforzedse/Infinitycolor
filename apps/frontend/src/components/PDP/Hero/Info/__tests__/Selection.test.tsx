import { fireEvent, render, screen } from "@testing-library/react";
import Info from "../index";

jest.mock("../Main", () => () => null);
jest.mock("../FAQItem", () => () => null);
jest.mock("../CommentsInfo", () => () => null);
jest.mock("../useScrollToComments", () => ({ useScrollToComments: () => jest.fn() }));
jest.mock("../Price", () => ({ price }: any) => <output data-testid="price">{price}</output>);
jest.mock("../Action", () => ({ variationId, hasStock, currentVariation }: any) =>
  <button
    data-testid="cart"
    disabled={!hasStock}
    data-variation={variationId || ""}
    data-current={currentVariation?.id || ""}
    data-sku={currentVariation?.attributes?.SKU || ""}
    data-stock={currentVariation?.attributes?.product_stock?.data?.attributes?.Count ?? ""}
  >cart</button>);
jest.mock("../Size", () => ({ sizes, selectedSize, onSizeChange }: any) =>
  <div>{sizes.map((s: any) => <button key={s.id} aria-pressed={selectedSize === s.id} onClick={() => onSizeChange(s.id)}>{s.title}</button>)}</div>);
jest.mock("../Color", () => ({ colors, selectedColor, onColorChange }: any) =>
  <div>{colors.map((c: any) => <button key={c.id} aria-pressed={selectedColor === c.id} onClick={() => onColorChange(c.id)}>{c.title}</button>)}</div>);
jest.mock("../Model", () => () => null);
jest.mock("../GenericAttributes", () => {
  function GenericAttributesMock({ selectors, selection, disabledTermIds, onChange }: any) {
    return (
      <div data-testid="generic-selectors">
        {selectors.map((selector: any) => (
          <section key={selector.attributeId}>
            <h3>{selector.title}</h3>
            {selector.options.map((option: any) => (
              <button
                key={option.id}
                disabled={disabledTermIds.has(option.id)}
                aria-pressed={selection[String(selector.attributeId)] === option.id}
                onClick={() => onChange(String(selector.attributeId), option.id)}
              >{option.title}</button>
            ))}
          </section>
        ))}
      </div>
    );
  }

  return GenericAttributesMock;
});

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

it("renders a custom variation axis even when it is hidden from specifications", () => {
  const withCustomAttribute = JSON.parse(JSON.stringify(productData));
  withCustomAttribute.attributes.product_attribute_assignments = {
    data: [
      {
        id: 9,
        attributes: {
          IsVisible: false,
          IsVariation: true,
          product_attribute: {
            data: {
              id: 31,
              attributes: {
                Title: "کد رنگ",
                Type: "Text",
                LegacyProjection: "None",
              },
            },
          },
          terms: {
            data: [{ id: 101, attributes: { Title: "کد ۱" } }],
          },
        },
      },
    ],
  };

  render(<Info {...props} productData={withCustomAttribute} />);

  expect(screen.getByTestId("generic-selectors")).toHaveTextContent("کد رنگ");
});

it("enables only purchasable custom terms and resolves exact price, SKU, stock, and cart identity", () => {
  const customVariation = (
    id: number,
    termId: number,
    price: number,
    stock: number,
    published = true,
  ) => ({
    id,
    attributes: {
      SKU: `WC-1291566-${id}`,
      Price: price,
      DiscountPrice: null,
      IsPublished: published,
      selected_attribute_terms: {
        data: [{
          id: termId,
          attributes: {
            Title: `کد ${termId - 724}`,
            product_attribute: { data: { id: 31, attributes: { Title: "کد رنگ" } } },
          },
        }],
      },
      product_stock: { data: { id: id + 1000, attributes: { Count: stock } } },
      product_variation_color: { data: null },
      product_variation_size: { data: null },
      product_variation_model: { data: null },
    },
  });
  const customProduct = {
    id: 4557,
    attributes: {
      Title: "شورت بهاره Y 00761",
      Slug: "شورت-بهاره-y00761",
      product_attribute_assignments: {
        data: [{
          id: 5091,
          attributes: {
            IsVisible: false,
            IsVariation: true,
            Position: 0,
            product_attribute: {
              data: { id: 31, attributes: { Title: "کد رنگ", Type: "Text", LegacyProjection: "None" } },
            },
            terms: {
              data: [725, 726, 727, 728, 729].map((id) => ({
                id,
                attributes: { Title: `کد ${id - 724}`, Position: id - 725 },
              })),
            },
          },
        }],
      },
      product_variations: {
        data: [
          customVariation(30173, 725, 299000, 1),
          customVariation(30174, 726, 309000, 4),
          customVariation(30179, 727, 319000, 2, false),
          customVariation(30180, 728, 329000, 0),
          customVariation(30181, 729, 339000, 5),
        ],
      },
    },
  } as any;

  render(<Info {...props} colors={[]} sizes={[]} productData={customProduct} />);

  expect(screen.getByRole("button", { name: "کد 1" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "کد 2" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "کد 3" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "کد 4" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "کد 5" })).toBeEnabled();

  fireEvent.click(screen.getByRole("button", { name: "کد 2" }));
  expect(screen.getByTestId("price")).toHaveTextContent("309000");
  expect(screen.getByTestId("cart")).toBeEnabled();
  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "30174");
  expect(screen.getByTestId("cart")).toHaveAttribute("data-current", "30174");
  expect(screen.getByTestId("cart")).toHaveAttribute("data-sku", "WC-1291566-30174");
  expect(screen.getByTestId("cart")).toHaveAttribute("data-stock", "4");
});
