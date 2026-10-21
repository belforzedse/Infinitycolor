import { CatalogEditError, catalogMutationContext } from "../../../utils/catalogEdit";

// Strapi updates repeatable components before the product's beforeUpdate hook.
// Capture their old state while the product lease/revision lock is held.
export async function captureColorGalleriesBefore(strapi: any, productId: number) {
  const context = catalogMutationContext();
  if (!context?.ids.includes(productId)) throw new CatalogEditError("CATALOG_GUARD_REQUIRED", 500);
  const product = await strapi.entityService.findOne("api::product.product", productId, {
    fields: ["id"],
    populate: {
      ColorGalleries: {
        fields: ["id"],
        populate: { color: { fields: ["id"] }, Images: { fields: ["id"] } },
      },
    },
  });
  context.colorGalleriesBefore ??= new Map();
  context.colorGalleriesBefore.set(productId, product?.ColorGalleries ?? []);
}

export async function validateColorGalleriesInput(
  strapi: any,
  galleries: unknown,
  productId: number | null = null,
) {
  if (!Array.isArray(galleries)) {
    throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
  }
  const seenColors = new Set<number>();
  const componentIds = new Set<number>();
  for (const gallery of galleries) {
    if (!gallery || typeof gallery !== "object" || Array.isArray(gallery)) {
      throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
    }
    if (Object.keys(gallery).some((key) => !["id", "color", "Images"].includes(key))) {
      throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
    }
    if (gallery.id !== undefined) {
      if (
        !productId ||
        !Number.isSafeInteger(gallery.id) ||
        gallery.id <= 0 ||
        componentIds.has(gallery.id)
      ) {
        throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
      }
      componentIds.add(gallery.id);
    }

    if (!Number.isSafeInteger(gallery.color) || gallery.color <= 0) {
      throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
    }
    if (seenColors.has(gallery.color)) {
      throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
    }

    seenColors.add(gallery.color);

    if (
      !Array.isArray(gallery.Images) ||
      gallery.Images.some((id: number) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(gallery.Images).size !== gallery.Images.length
    ) {
      throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
    }
  }
  if (componentIds.size && productId) {
    let previous = catalogMutationContext()?.colorGalleriesBefore?.get(productId);
    if (!previous) {
      const product = await strapi.entityService.findOne("api::product.product", productId, {
        fields: ["id"],
        populate: { ColorGalleries: { fields: ["id"] } },
      });
      previous = product?.ColorGalleries ?? [];
    }
    const owned = new Set((previous ?? []).map((gallery: any) => gallery.id));
    if ([...componentIds].some((id) => !owned.has(id))) {
      throw new CatalogEditError("CATALOG_PARENT_CHANGE_FORBIDDEN", 400);
    }
  }
  if (seenColors.size === 0) return;

  const colors = await strapi.db
    .query("api::product-variation-color.product-variation-color")
    .findMany({
      where: {
        id: {
          $in: [...seenColors],
        },
      },
      select: ["id"],
    });

  if (colors.length !== seenColors.size) {
    throw new CatalogEditError("CATALOG_RELATION_INVALID", 400);
  }
  const imageIds = [...new Set<number>(galleries.flatMap((gallery) => gallery.Images))];

  if (imageIds.length === 0) return;

  const files = await strapi.db.query("plugin::upload.file").findMany({
    where: {
      id: {
        $in: imageIds,
      },
    },
    select: ["id", "mime"],
  });

  if (files.length !== imageIds.length) {
    throw new CatalogEditError("PRODUCT_MEDIA_NOT_FOUND", 400);
  }

  if (files.some((file: any) => typeof file.mime !== "string" || !file.mime.startsWith("image/"))) {
    throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
  }
}
