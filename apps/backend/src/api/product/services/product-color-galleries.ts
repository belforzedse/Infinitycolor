import { CatalogEditError } from "../../../utils/catalogEdit";
export async function validateColorGalleriesInput(strapi: any, galleries: unknown) {
  if (!Array.isArray(galleries)) {
    throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
  }
  const seenColors = new Set<number>();
  for (const gallery of galleries) {
    if (!gallery || typeof gallery !== "object" || Array.isArray(gallery)) {
      throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
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
      gallery.Images.some((id: number) => !Number.isSafeInteger(id) || id <= 0)
    ) {
      throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
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
