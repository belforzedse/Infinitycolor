import { apiClient } from "@/services";
import { ENDPOINTS } from "@/constants/api";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import type { ApiResponse } from "@/types/api";
import { paramCreator } from "@/utils/paramCreator";
import type { TagAttributes } from "./tag/get";
import type { HomeGifPromoAssignment } from "@/types/super-admin/settings";
import type { ProductCardProps } from "@/components/Product/Card";
import { formatProductsToCardProps } from "@/services/product/product";

type PopulateObject = {
  [key: string]: boolean | PopulateObject;
};

interface Item {
  id: number;
  attributes: ProductDataResponse;
}

export interface MediaAttributes {
  name: string;
  alternativeText: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  formats: any | null;
  hash: string;
  ext: string;
  mime: string;
  size: number;
  url: string;
  previewUrl: string | null;
  provider: string;
  provider_metadata: any | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaDataItem {
  id: number;
  attributes: MediaAttributes;
}

export interface MediaField {
  data: MediaDataItem[];
}

export interface CoverImageField {
  data: {
    id: number;
    attributes: MediaAttributes;
  } | null;
}

export interface GenericRelation<T> {
  data: T | null;
}

export interface GenericRelationArray<T> {
  data: T[];
}

export interface ProductDataResponse {
  Title: string;
  Description: string;
  Status: string;
  scheduledPublishAt?: string | null;
  scheduledPublishTimezone?: string | null;
  scheduledPublishLastAttemptAt?: string | null;
  scheduledPublishLastError?: string | null;
  scheduledPublishFailureKind?: "Transient" | "Permanent" | null;
  ProductType?: "Variable" | "Simple" | null;
  IsSimpleProduct?: boolean | null;
  Weight?: number;
  AverageRating: number | null;
  RatingCount: number | null;
  createdAt: string;
  updatedAt: string;
  CleaningTips: string | null;
  ReturnConditions: string | null;
  removedAt: string | null;
  Files: MediaField;
  Media: MediaField;
  CoverImage: CoverImageField;
  product_main_category: GenericRelation<unknown>;
  product_tags: GenericRelationArray<TagAttributes>;
  product_variations: GenericRelationArray<unknown>;
  product_other_categories: GenericRelationArray<unknown>;
}

export const getProduct = async (
  id: string,
  params: PopulateObject,
): Promise<ApiResponse<Item>> => {
  const endpoint = `${ENDPOINTS.PRODUCT.PRODUCT}/${id}?${paramCreator(params)}`;
  // Use no-store cache for super-admin pages to ensure fresh data
  const response = await apiClient.get<ApiResponse<Item>>(endpoint, {
    cache: "no-store",
  });

  return response as any;
};

export type ProductSummary = {
  id: number;
  title: string;
  image?: string;
};

/** Strapi's `api.rest.maxLimit` (apps/backend/config/api.ts). A request for more
 *  than this is silently truncated, so batch rather than ask for everything. */
const PRODUCT_QUERY_MAX_LIMIT = 100;

/**
 * Fetch minimal product data (id, title, image) by IDs for display in pickers.
 * Preserves order of requested ids in the result.
 *
 * Both the limit and the batching are load-bearing. Strapi's default pageSize is 25
 * and it pages by id, so asking for 26 ids without a limit returns 25 and silently
 * drops the HIGHEST one — the picker then draws that row as `محصول #<id>` with no
 * thumbnail. Verified against production: 26 requested returned 25 (pageCount 2),
 * missing exactly the largest id. Asking for more than `maxLimit` at once truncates
 * the same way, which is why this batches instead of sending one big limit.
 */
export async function getProductSummariesByIds(ids: number[]): Promise<ProductSummary[]> {
  if (ids.length === 0) return [];

  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += PRODUCT_QUERY_MAX_LIMIT) {
    batches.push(ids.slice(i, i + PRODUCT_QUERY_MAX_LIMIT));
  }

  const responses = await Promise.all(
    batches.map((batch) => {
      const params = new URLSearchParams();
      batch.forEach((id, i) => params.set(`filters[id][$in][${i}]`, String(id)));
      params.set("pagination[limit]", String(batch.length));
      params.set("pagination[withCount]", "false");
      params.set("populate[0]", "CoverImage");
      params.set("fields[0]", "Title");
      params.set("fields[1]", "id");
      const endpoint = `${ENDPOINTS.PRODUCT.PRODUCT}?${params.toString()}`;
      return apiClient.get(endpoint, { cache: "no-store" }) as Promise<any>;
    }),
  );

  const list = responses.flatMap((res: any) => res?.data ?? []);
  const idToIndex = new Map(ids.map((id, i) => [id, i]));
  const withOrder = list.map((raw: any) => {
    const id = raw.id;
    const attrs = raw.attributes ?? {};
    const title = typeof attrs.Title === "string" ? attrs.Title : `محصول #${id}`;
    let image: string | undefined;
    const cover = attrs.CoverImage as CoverImageField | undefined;
    if (cover?.data?.attributes?.url) {
      const url = cover.data.attributes.url;
      image = resolveAssetUrl(url) || undefined;
    }
    return { id, title, image, order: idToIndex.get(id) ?? 0 };
  });
  withOrder.sort((a: any, b: any) => a.order - b.order);
  return withOrder.map(({ id, title, image }: any) => ({ id, title, image }));
}

export async function getGifPromoPreviewProducts(
  assignment: HomeGifPromoAssignment,
): Promise<ProductCardProps[]> {
  const params = new URLSearchParams();
  params.set("view", "card");
  params.set("filters[Status][$eq]", "Active");
  params.set("filters[removedAt][$null]", "true");
  params.set("filters[product_variations][Price][$gte]", "1");
  params.set("filters[product_variations][product_stock][Count][$gt]", "0");
  params.set("pagination[withCount]", "false");

  if (assignment.mode === "manual") {
    const ids = assignment.productIds.slice(0, 4);
    if (ids.length === 0) return [];
    ids.forEach((id, index) => params.set(`filters[id][$in][${index}]`, String(id)));
    params.set("pagination[limit]", String(Math.max(ids.length, 4)));

    const res = (await apiClient.get(`${ENDPOINTS.PRODUCT.PRODUCT}?${params.toString()}`, {
      cache: "no-store",
    })) as any;
    const list = formatProductsToCardProps(res?.data ?? []);
    const order = new Map(ids.map((id, index) => [id, index]));
    return list
      .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999))
      .slice(0, 4);
  }

  const categorySlug = assignment.categorySlug.trim();
  if (!categorySlug) return [];

  params.set("filters[product_main_category][Slug][$eq]", categorySlug);
  params.set("sort[0]", "createdAt:desc");
  params.set("pagination[limit]", "4");

  const res = (await apiClient.get(`${ENDPOINTS.PRODUCT.PRODUCT}?${params.toString()}`, {
    cache: "no-store",
  })) as any;
  return formatProductsToCardProps(res?.data ?? []).slice(0, 4);
}
