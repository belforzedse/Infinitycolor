import { apiClient } from "@/services";
import type {
  EditProductData,
  ProductData,
} from "@/types/super-admin/products";
import type {
  ProductEditorClient,
  ProductEditSnapshot,
} from "./editor-session";

interface TransformedProductData
  extends Omit<
    ProductData,
    | "product_main_category"
    | "product_tags"
    | "product_other_categories"
    | "Media"
    | "ColorGalleries"
    | "Files"
    | "CoverImage"
    | "Status"
    | "scheduledPublishAt"
    | "scheduledPublishTimezone"
    | "scheduledPublishLastAttemptAt"
    | "scheduledPublishLastError"
    | "scheduledPublishFailureKind"
  > {
  product_main_category: number | null;
  product_tags: number[];
  product_other_categories: number[];
  CoverImage?: number | null;
  Media?: number[];
  ColorGalleries?: Array<{
    id?: number;
    color: number;
    Images: number[];
  }>;
  Files?: number[];
}

export function transformProductDataForApi(
  data: EditProductData,
): TransformedProductData {
  // Create a new object without the CoverImage field. Simple* fields live on the
  // synthetic variation (synced separately), so they are stripped here too.
  const {
    CoverImage,
    SimpleVariationId,
    SimpleStockId,
    SimpleStockRevision,
    SimpleSKU,
    SimplePrice,
    SimpleDiscountPrice,
    SimpleStock,
    SimpleIsPublished,
    Status: _publicationStatus,
    scheduledPublishAt: _scheduledPublishAt,
    scheduledPublishTimezone: _scheduledPublishTimezone,
    scheduledPublishLastAttemptAt: _scheduledPublishLastAttemptAt,
    scheduledPublishLastError: _scheduledPublishLastError,
    scheduledPublishFailureKind: _scheduledPublishFailureKind,
    ...rest
  } = data;

  const productType =
    rest.ProductType === "Simple" || rest.IsSimpleProduct
      ? "Simple"
      : "Variable";

  const transformedData: TransformedProductData = {
    ...rest,
    ProductType: productType,
    IsSimpleProduct: productType === "Simple",
    Media: data.Media?.map((media) => +media.id),
    ColorGalleries: data.ColorGalleries?.map((gallery) => ({
      id: gallery.id,
      color: gallery.color,
      Images: gallery.Images.map((image) => image.id),
    })),
    Files: data.Files?.map((file) => +file.id),
    product_main_category: data.product_main_category?.id || null,
    product_tags: data.product_tags.map((tag) => tag.id),
    product_other_categories: data.product_other_categories.map(
      (category) => category.id,
    ),
  };

  // Handle CoverImage: include ID if exists, or null if explicitly deleted
  // Check if CoverImage is explicitly set (either null or has data property)
  if (CoverImage === null || (CoverImage && CoverImage.data === null)) {
    // CoverImage is explicitly set to null or CoverImage.data is null (deleted)
    transformedData.CoverImage = null;
  } else if (CoverImage?.data?.id) {
    // CoverImage has a valid ID
    transformedData.CoverImage = CoverImage.data.id;
  }
  // If CoverImage is undefined, don't include it in the payload (no change)

  return transformedData;
}

export type SizeGuidePayload = { id?: number; Helper: unknown };

export function buildProductEditorPayload(
  body: EditProductData,
  base: EditProductData,
  sizeGuide?: SizeGuidePayload,
) {
  const isSimple = body.ProductType === "Simple" || body.IsSimpleProduct;
  const isNewVariation = !body.SimpleVariationId;
  const simpleFields = {
    ...(isNewVariation || body.SimpleSKU !== base.SimpleSKU
      ? { SKU: body.SimpleSKU?.trim() || undefined }
      : {}),
    ...(isNewVariation || body.SimplePrice !== base.SimplePrice
      ? { Price: Number(body.SimplePrice || 0) }
      : {}),
    ...(isNewVariation ||
    (body.SimpleDiscountPrice ?? null) !== (base.SimpleDiscountPrice ?? null)
      ? { DiscountPrice: body.SimpleDiscountPrice ?? null }
      : {}),
    ...(isNewVariation || body.SimpleIsPublished !== base.SimpleIsPublished
      ? { IsPublished: body.SimpleIsPublished !== false }
      : {}),
    // Stock is volatile. A title/image-only save must never write a loaded count.
    ...(isNewVariation || body.SimpleStock !== base.SimpleStock
      ? {
          stock: {
            ...(body.SimpleStockId
              ? {
                  id: body.SimpleStockId,
                  expectedStockRevision: base.SimpleStockRevision,
                }
              : {}),
            Count: Number(body.SimpleStock || 0),
          },
        }
      : {}),
  };
  const simpleVariation =
    isSimple && Object.keys(simpleFields).length
      ? {
          ...(body.SimpleVariationId ? { id: body.SimpleVariationId } : {}),
          ...simpleFields,
        }
      : undefined;
  const data = transformProductDataForApi(body);
  // An unrelated edit must preserve mappings the form did not change/read.
  if (JSON.stringify(body.ColorGalleries) === JSON.stringify(base.ColorGalleries)) {
    delete data.ColorGalleries;
  }
  return {
    data,
    ...(simpleVariation ? { simpleVariation } : {}),
    ...(sizeGuide ? { sizeGuide } : {}),
  };
}

export const updateProduct = async (
  id: string,
  body: EditProductData,
  base: EditProductData,
  client: ProductEditorClient = apiClient,
  sizeGuide?: SizeGuidePayload,
) =>
  client.put<ProductEditSnapshot>(
    `/products/${id}/editor`,
    buildProductEditorPayload(body, base, sizeGuide),
    { retries: 0 },
  );
