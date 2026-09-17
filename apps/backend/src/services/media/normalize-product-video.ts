import {
  collectVideoUploads,
  loadUploadVideoFile,
  looksLikeUnsafeWebVideo,
  normalizeUploadFile,
  type NormalizeFileDeps,
  type NormalizeFileResult,
} from "./normalize-upload-video";

export interface NormalizeProductResult {
  productId: number;
  slug?: string | null;
  status: "missing" | "skipped" | "normalized" | "would-normalize";
  files: NormalizeFileResult[];
  detail?: string;
}

const PRODUCT_VIDEO_POPULATE = {
  fields: ["id", "Slug", "Status"],
  populate: { CoverImage: true, Media: true },
} as const;

export async function normalizeProductVideoFile(
  productId: number,
  fileId: number,
  deps: NormalizeFileDeps,
): Promise<NormalizeProductResult> {
  const product = await deps.strapi.entityService.findOne(
    "api::product.product",
    productId,
    PRODUCT_VIDEO_POPULATE,
  );
  if (!product) {
    return { productId, status: "missing", files: [], detail: "product not found" };
  }

  const attached = collectVideoUploads(product);
  const attachedIds = new Set(attached.map((file) => file.id));
  if (!attachedIds.has(fileId)) {
    return {
      productId,
      slug: product.Slug,
      status: "missing",
      files: [],
      detail: `file ${fileId} is not attached to this product`,
    };
  }

  const file = attached.find((entry) => entry.id === fileId) ?? (await loadUploadVideoFile(deps.strapi, fileId));
  if (!file) {
    return { productId, slug: product.Slug, status: "missing", files: [], detail: "upload row missing" };
  }

  const result = await normalizeUploadFile(file, {
    ...deps,
    nameHint: `product-${productId}-${fileId}`,
  });
  return {
    productId,
    slug: product.Slug,
    status: result.status === "missing" ? "missing" : result.status,
    files: [result],
  };
}

export async function normalizeProductVideos(
  productId: number,
  deps: NormalizeFileDeps,
): Promise<NormalizeProductResult> {
  const product = await deps.strapi.entityService.findOne(
    "api::product.product",
    productId,
    PRODUCT_VIDEO_POPULATE,
  );
  if (!product) {
    return { productId, status: "missing", files: [], detail: "product not found" };
  }

  const files = collectVideoUploads(product);
  if (files.length === 0) {
    return { productId, slug: product.Slug, status: "missing", files: [], detail: "no video media" };
  }

  const results: NormalizeFileResult[] = [];
  for (const file of files) {
    results.push(
      await normalizeUploadFile(file, {
        ...deps,
        nameHint: `product-${productId}-${file.id}`,
      }),
    );
  }

  const status = summarizeFileStatuses(results);
  return { productId, slug: product.Slug, status, files: results };
}

function summarizeFileStatuses(files: NormalizeFileResult[]): NormalizeProductResult["status"] {
  if (files.some((file) => file.status === "normalized")) return "normalized";
  if (files.some((file) => file.status === "would-normalize")) return "would-normalize";
  if (files.some((file) => file.status === "skipped")) return "skipped";
  return "missing";
}

export async function findProductsNeedingVideoNormalization(strapi: any): Promise<number[]> {
  const ids: number[] = [];
  const pageSize = 100;
  for (let start = 0; start < 20_000; start += pageSize) {
    const batch = await strapi.entityService.findMany("api::product.product", {
      fields: ["id"],
      populate: { CoverImage: true, Media: true },
      start,
      limit: pageSize,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const product of batch) {
      const videos = collectVideoUploads(product);
      if (videos.some((file) => looksLikeUnsafeWebVideo(file) && file.url)) {
        ids.push(product.id);
      }
    }
    if (batch.length < pageSize) break;
  }
  return ids;
}
