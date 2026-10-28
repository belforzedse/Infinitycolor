import { loadEditorSnapshot } from "../services/product-editor-snapshot";
import productSchema from "../content-types/product/schema.json";
import gallerySchema from "../../../components/product/color-gallery.json";

jest.mock("@strapi/utils", () => ({
  sanitize: {
    contentAPI: {
      output: jest.fn(async (entity: any) => entity),
    },
  },
}));

describe("loadEditorSnapshot", () => {
  it("returns the color gallery and preserves image order", async () => {
    const product = {
      id: 1,
      EditRevision: 3,
      ColorGalleries: [
        {
          id: 7,
          color: { id: 2, Title: "صورتی" },
          Images: [
            { id: 20, url: "/pink-model.jpg" },
            { id: 10, url: "/pink-product.jpg" },
          ],
        },
      ],
    };

    const models: Record<string, any> = {
      "api::product.product": productSchema,
      "product.color-gallery": gallerySchema,
      "api::product-variation-color.product-variation-color": {
        attributes: {},
      },
      "plugin::upload.file": {
        attributes: {},
      },
    };

    const strapi = {
      entityService: {
        findOne: jest.fn().mockResolvedValue(product),
      },
      getModel: jest.fn((uid: string) => models[uid]),
    };

    const result = await loadEditorSnapshot(strapi, 1);

    expect(result.revision).toBe(3);

    expect(result.product.attributes.ColorGalleries).toEqual([
      {
        id: 7,
        color: {
          data: {
            id: 2,
            attributes: { Title: "صورتی" },
          },
        },
        Images: {
          data: [
            {
              id: 20,
              attributes: { url: "/pink-model.jpg" },
            },
            {
              id: 10,
              attributes: { url: "/pink-product.jpg" },
            },
          ],
        },
      },
    ]);
  });
});
