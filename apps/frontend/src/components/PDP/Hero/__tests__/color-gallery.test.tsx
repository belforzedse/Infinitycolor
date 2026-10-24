import { fireEvent, render, screen } from "@testing-library/react";
import Hero from "../index";
import {
  formatGalleryAssets,
  formatAllGalleryAssets,
  type ProductDetail,
  type ProductMedia,
} from "@/services/product/product";
import { normalizeProductDetail } from "@/app/(product)/pdp/normalizeProductDetail";

jest.mock("@/lib/adaptive-quality", () => ({
  useAdaptiveQuality: () => ({ media: "economy" }),
  noteEnhancementLoaded: jest.fn(),
}));
jest.mock("../Gallery/SingleImage", () => ({ src, alt, goToNextImage, goToPreviousImage }: any) => (
  <div>
    <img data-testid="active-photo" src={src} alt={alt} />
    <button onClick={goToNextImage}>next photo</button>
    <button onClick={goToPreviousImage}>previous photo</button>
  </div>
));
jest.mock("../Gallery/ThumbnailList", () => ({ assets, selectedImage, setSelectedImage }: any) => (
  <div>
    {assets.map((asset: any) => (
      <button
        key={asset.id}
        aria-pressed={selectedImage === asset.id}
        onClick={() => setSelectedImage(asset.id)}
      >
        photo {asset.id}
      </button>
    ))}
  </div>
));
jest.mock("../Info/CommentsInfo", () => () => null);
jest.mock("../Info/FAQItem", () => () => null);
jest.mock("../Info/useScrollToComments", () => ({ useScrollToComments: () => jest.fn() }));
jest.mock("../Info/GenericAttributes", () => () => null);
jest.mock("../Info/Price", () => ({ price }: any) => <output data-testid="price">{price}</output>);
jest.mock("../Info/Action", () => ({ variationId, currentVariation, hasStock }: any) => (
  <button
    data-testid="cart"
    disabled={!hasStock}
    data-variation={variationId}
    data-sku={currentVariation?.attributes.SKU}
  >
    cart
  </button>
));
jest.mock("../Info/Color", () => ({ colors, selectedColor, onColorChange }: any) => (
  <div>
    {colors.map((color: any) => (
      <button
        key={color.id}
        aria-pressed={color.id === selectedColor}
        onClick={() => onColorChange(color.id)}
      >
        {color.title}
      </button>
    ))}
  </div>
));
jest.mock("../Info/Size", () => ({ sizes, onSizeChange }: any) => (
  <div>
    {sizes.map((size: any) => (
      <button key={size.id} onClick={() => onSizeChange(size.id)}>
        {size.title}
      </button>
    ))}
  </div>
));
jest.mock("../Info/Model", () => ({ models, onModelChange }: any) => (
  <div>
    {models.map((model: any) => (
      <button key={model.id} onClick={() => onModelChange(model.id)}>
        {model.title}
      </button>
    ))}
  </div>
));

const photo = (id: number): ProductMedia => ({
  id,
  attributes: {
    name: "photo-" + id,
    alternativeText: "photo " + id,
    caption: null,
    width: 800,
    height: 1000,
    formats: null,
    mime: "image/jpeg",
    url: "/uploads/photo-" + id + ".jpg",
    ext: ".jpg",
  },
});

function fixture(): ProductDetail {
  const variations: ProductDetail["attributes"]["product_variations"]["data"] = [];
  for (const color of [1, 2, 3])
    for (const size of [1, 2])
      for (const model of [1, 2]) {
        const id = color * 100 + size * 10 + model;
        variations.push({
          id,
          attributes: {
            SKU: "SKU-" + id,
            Price: id * 100,
            IsPublished: true,
            product_variation_color: {
              data: {
                id: color,
                attributes: {
                  Title: ["", "قرمز", "آبی", "سبز"][color],
                  ColorCode: ["", "#f00", "#00f", "#0f0"][color],
                },
              },
            },
            product_variation_size: {
              data: { id: size, attributes: { Title: size === 1 ? "S" : "M" } },
            },
            product_variation_model: {
              data: { id: model, attributes: { Title: model === 1 ? "A" : "B" } },
            },
            product_stock: { data: { id, attributes: { Count: 10 } } },
          },
        });
      }
  return {
    id: 1,
    attributes: {
      Title: "محصول آزمایشی",
      Description: "",
      Status: "Active",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      CoverImage: { data: photo(1) },
      Media: { data: [photo(2)] },
      product_main_category: { data: null },
      product_variations: { data: variations },
      ColorGalleries: [
        {
          id: 7,
          color: { data: { id: 1, attributes: { Title: "قرمز" } } },
          Images: { data: [photo(20), photo(30)] },
        },
        {
          id: 8,
          color: { data: { id: 2, attributes: { Title: "آبی" } } },
          Images: { data: [photo(30), photo(40)] },
        },
      ],
    },
  };
}

const active = () => screen.getByTestId("active-photo").getAttribute("src");
it("shows cover first and keeps all photos when selecting a color", () => {
  render(<Hero productData={fixture()} productId="1" />);

  expect(active()).toContain("photo-1.jpg");

  for (const id of [1, 2, 20, 30, 40]) {
    expect(screen.getAllByRole("button", { name: `photo ${id}` })[0]).toBeInTheDocument();
  }

  fireEvent.click(screen.getByText("آبی"));
  expect(active()).toContain("photo-30.jpg");

  expect(screen.getAllByRole("button", { name: "photo 30" })[0]).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  fireEvent.click(screen.getByText("next photo"));
  expect(active()).toContain("photo-40.jpg");

  fireEvent.click(screen.getByText("next photo"));
  expect(active()).toContain("photo-1.jpg");

  fireEvent.click(screen.getAllByRole("button", { name: "photo 20" })[0]);
  expect(active()).toContain("photo-20.jpg");

  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "211");
  expect(screen.getByTestId("cart")).toHaveAttribute("data-sku", "SKU-211");
  expect(screen.getByTestId("price")).toHaveTextContent("21100");

  for (const id of [1, 2, 20, 30, 40]) {
    expect(screen.getAllByRole("button", { name: `photo ${id}` })[0]).toBeInTheDocument();
  }
});

it("leaves the chosen gallery photo alone when size or model changes", () => {
  render(<Hero productData={fixture()} productId="1" />);

  fireEvent.click(screen.getByText("قرمز"));

  fireEvent.click(screen.getByText("next photo"));
  expect(active()).toContain("photo-30.jpg");

  fireEvent.click(screen.getByText("M"));
  fireEvent.click(screen.getByText("B"));

  expect(active()).toContain("photo-30.jpg");

  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "122");
  expect(screen.getByTestId("cart")).toHaveAttribute("data-sku", "SKU-122");
  expect(screen.getByTestId("price")).toHaveTextContent("12200");
});

it("falls back to the product cover while keeping all thumbnails", () => {
  render(<Hero productData={fixture()} productId="1" />);

  fireEvent.click(screen.getByText("آبی"));
  expect(active()).toContain("photo-30.jpg");

  fireEvent.click(screen.getByText("سبز"));
  expect(active()).toContain("photo-1.jpg");

  expect(screen.getAllByRole("button", { name: "photo 40" })[0]).toBeInTheDocument();

  expect(screen.getAllByRole("button", { name: "photo 1" })[0]).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  fireEvent.click(screen.getByText("next photo"));
  expect(active()).toContain("photo-2.jpg");

  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "311");
});

it("shows the cover and allows photo selection for a single-color product", () => {
  const product = fixture();

  product.attributes.product_variations.data = [product.attributes.product_variations.data[0]];

  render(<Hero productData={product} productId="1" />);

  expect(active()).toContain("photo-1.jpg");

  expect(screen.queryByRole("button", { name: "قرمز" })).not.toBeInTheDocument();

  fireEvent.click(screen.getAllByRole("button", { name: "photo 20" })[0]);
  expect(active()).toContain("photo-20.jpg");

  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "111");
  expect(screen.getByTestId("price")).toHaveTextContent("11100");
});

it("keeps the in-stock cart selection and resets the gallery on product navigation", () => {
  const product = fixture();

  for (const variation of product.attributes.product_variations.data) {
    if (variation.attributes.product_variation_color?.data.id === 1) {
      variation.attributes.product_stock!.data.attributes.Count = 0;
    }
  }

  const { rerender } = render(<Hero productData={product} productId="1" />);

  expect(active()).toContain("photo-1.jpg");
  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "211");

  fireEvent.click(screen.getByText("آبی"));
  fireEvent.click(screen.getByText("next photo"));
  expect(active()).toContain("photo-40.jpg");

  const second = fixture();
  second.id = 2;
  second.attributes.CoverImage = { data: photo(50) };

  rerender(<Hero productData={second} productId="2" />);

  expect(active()).toContain("photo-50.jpg");

  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "111");
  expect(screen.getByTestId("price")).toHaveTextContent("11100");
});

it("normalizes raw and REST-shaped color mappings without changing order", () => {
  const product = fixture();
  const rawGallery = {
    id: 7,
    color: { id: 1, Title: "قرمز" },
    Images: [
      { id: 20, ...photo(20).attributes },
      { id: 30, ...photo(30).attributes },
    ],
  };
  const raw = normalizeProductDetail({
    id: 1,
    ...product.attributes,
    ColorGalleries: [rawGallery],
  })!;
  const rest = normalizeProductDetail(product)!;
  expect(formatGalleryAssets(raw, 1).map((asset) => asset.id)).toEqual(["20", "30"]);
  expect(formatGalleryAssets(rest, 1).map((asset) => asset.id)).toEqual(["20", "30"]);
  expect(formatGalleryAssets(rest, 2).map((asset) => asset.id)).toEqual(["30", "40"]);
  expect(formatGalleryAssets(rest, 3).map((asset) => asset.id)).toEqual(["1", "2"]);
  rest.attributes.ColorGalleries![0].Images.data = [];
  expect(formatGalleryAssets(rest, 1).map((asset) => asset.id)).toEqual(["1", "2"]);
});

it("updates the cover when fresh data arrives for the same product", () => {
  const product = fixture();

  const { rerender } = render(<Hero productData={product} productId="1" />);

  expect(active()).toContain("photo-1.jpg");

  const updatedProduct = fixture();
  updatedProduct.attributes.CoverImage = { data: photo(50) };

  rerender(<Hero productData={updatedProduct} productId="1" />);

  expect(active()).toContain("photo-50.jpg");

  expect(screen.getByTestId("cart")).toHaveAttribute("data-variation", "111");
  expect(screen.getByTestId("price")).toHaveTextContent("11100");
});
it("deduplicates shared photos while preserving gallery order", () => {
  const assets = formatAllGalleryAssets(fixture());

  expect(assets.map((asset) => asset.id)).toEqual(["1", "2", "20", "30", "40"]);
});
