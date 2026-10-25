import { validateColorGalleriesInput } from "../services/product-color-galleries";

describe("validateColorGalleriesInput", () => {
  it.each([
    [{ color: 1, Images: [10, 10] }],
    [{ id: 12, color: 1, Images: [] }],
    [{ color: 1, Images: [], unexpected: true }],
    [{ color: 1, Images: [0] }],
  ])("rejects malformed mappings before reading or writing records", async (gallery) => {
    const strapi = { db: { query: jest.fn() } };
    await expect(validateColorGalleriesInput(strapi, [gallery])).rejects.toMatchObject({
      code: "EDITOR_PAYLOAD_INVALID",
    });
    expect(strapi.db.query).not.toHaveBeenCalled();
  });

  it("rejects a component ID owned by another product", async () => {
    const strapi = {
      entityService: { findOne: jest.fn().mockResolvedValue({ ColorGalleries: [{ id: 9 }] }) },
      db: { query: jest.fn() },
    };
    await expect(
      validateColorGalleriesInput(strapi, [{ id: 8, color: 1, Images: [] }], 123),
    ).rejects.toMatchObject({ code: "CATALOG_PARENT_CHANGE_FORBIDDEN" });
    expect(strapi.entityService.findOne).toHaveBeenCalledWith(
      "api::product.product",
      123,
      expect.anything(),
    );
    expect(strapi.db.query).not.toHaveBeenCalled();
  });

  it("allows an owned component and the same photo on different colors", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
      .mockResolvedValueOnce([{ id: 10, mime: "image/jpeg" }]);
    const strapi = {
      entityService: { findOne: jest.fn().mockResolvedValue({ ColorGalleries: [{ id: 9 }] }) },
      db: { query: jest.fn().mockReturnValue({ findMany }) },
    };
    await expect(
      validateColorGalleriesInput(
        strapi,
        [
          { id: 9, color: 1, Images: [10] },
          { color: 2, Images: [10] },
        ],
        123,
      ),
    ).resolves.toBeUndefined();
  });
  it("accepts an empty gallery list", async () => {
    const strapi = {
      db: {
        query: jest.fn(),
      },
    };

    await expect(validateColorGalleriesInput(strapi, [])).resolves.toBeUndefined();

    expect(strapi.db.query).not.toHaveBeenCalled();
  });

  it("rejects duplicate colors", async () => {
    const strapi = {
      db: {
        query: jest.fn(),
      },
    };

    const galleries = [
      { color: 1, Images: [10] },
      { color: 1, Images: [20] },
    ];

    await expect(validateColorGalleriesInput(strapi, galleries)).rejects.toThrow(
      "EDITOR_PAYLOAD_INVALID",
    );

    expect(strapi.db.query).not.toHaveBeenCalled();
  });
  it("accepts a gallery with an existing color and images", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([
        { id: 10, mime: "image/jpeg" },
        { id: 20, mime: "image/webp" },
      ]);

    const strapi = {
      db: {
        query: jest.fn().mockReturnValue({ findMany }),
      },
    };

    await expect(
      validateColorGalleriesInput(strapi, [{ color: 1, Images: [10, 20] }]),
    ).resolves.toBeUndefined();
  });

  it("rejects a missing image", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 10, mime: "image/jpeg" }]);

    const strapi = {
      db: {
        query: jest.fn().mockReturnValue({ findMany }),
      },
    };

    await expect(
      validateColorGalleriesInput(strapi, [{ color: 1, Images: [10, 20] }]),
    ).rejects.toThrow("PRODUCT_MEDIA_NOT_FOUND");
  });
  it("rejects a missing color", async () => {
    const findMany = jest.fn().mockResolvedValueOnce([]);

    const strapi = {
      db: {
        query: jest.fn().mockReturnValue({ findMany }),
      },
    };

    await expect(
      validateColorGalleriesInput(strapi, [{ color: 999, Images: [10] }]),
    ).rejects.toThrow("CATALOG_RELATION_INVALID");
  });

  it("rejects a file that is not an image", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 10, mime: "application/pdf" }]);

    const strapi = {
      db: {
        query: jest.fn().mockReturnValue({ findMany }),
      },
    };

    await expect(validateColorGalleriesInput(strapi, [{ color: 1, Images: [10] }])).rejects.toThrow(
      "EDITOR_PAYLOAD_INVALID",
    );
  });
});
