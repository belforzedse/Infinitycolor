import { render, screen } from "@testing-library/react";
import QuickViewContent from "../QuickViewContent";

jest.mock("../QuickViewGallery", () => ({
  __esModule: true,
  default: ({ images }: { images: string[] }) => (
    <div data-testid="quick-view-gallery" data-images={images.join("|")} />
  ),
}));

jest.mock("../QuickViewVariationSelector", () => ({
  __esModule: true,
  default: () => <div data-testid="quick-view-variation-selector" />,
}));

jest.mock("../QuickViewPricing", () => ({
  __esModule: true,
  default: () => <div data-testid="quick-view-pricing" />,
}));

describe("QuickViewContent image normalization", () => {
  it("passes only allowed image urls to the quick-view gallery", () => {
    render(
      <QuickViewContent
        productId={1}
        onViewFullDetails={jest.fn()}
        onClose={jest.fn()}
        productData={
          {
            id: 1,
            attributes: {
              Title: "Test Product",
              CoverImage: {
                data: {
                  attributes: {
                    url: "https://external-domain.example/cover.webp",
                    mime: "image/webp",
                  },
                },
              },
              Media: {
                data: [
                  {
                    attributes: {
                      url: "/uploads/gallery.webp",
                      mime: "image/webp",
                    },
                  },
                ],
              },
              product_variations: {
                data: [
                  {
                    id: 1,
                    attributes: {
                      IsPublished: true,
                      Price: 100000,
                      product_stock: { data: { attributes: { Count: 3 } } },
                      product_variation_color: { data: null },
                      product_variation_size: { data: null },
                    },
                  },
                ],
              },
            },
          } as any
        }
      />,
    );

    const gallery = screen.getByTestId("quick-view-gallery");
    const images = gallery.getAttribute("data-images");
    expect(images).toContain("/uploads/gallery.webp");
    expect(images).not.toContain("external-domain.example");
  });
});
