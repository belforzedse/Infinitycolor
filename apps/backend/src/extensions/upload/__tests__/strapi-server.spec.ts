import extendUpload from "../strapi-server";

jest.mock("sharp", () => ({ __esModule: true, default: { cache: jest.fn() } }));

function service() {
  const original = {
    upload: jest.fn().mockResolvedValue([]),
    uploadToEntity: jest.fn().mockResolvedValue([]),
    replace: jest.fn(),
    remove: jest.fn(),
  };
  const plugin = extendUpload({ services: { upload: () => original } });
  return { original, guarded: plugin.services.upload() };
}

it.each(["api::product.product", "product.color-gallery"])(
  "requires the product editor for direct media attachment to %s",
  async (model) => {
    const { guarded } = service();
    await expect(guarded.upload({ data: { ref: model } })).rejects.toMatchObject({
      code: "PRODUCT_MEDIA_EDITOR_REQUIRED",
    });
    await expect(guarded.uploadToEntity({ model })).rejects.toMatchObject({
      code: "PRODUCT_MEDIA_EDITOR_REQUIRED",
    });
  },
);

it("continues to accept unattached uploads for the existing media picker", async () => {
  const { guarded } = service();
  await expect(guarded.upload({ data: {} })).resolves.toEqual([]);
});
