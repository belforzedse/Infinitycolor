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
  EditRevision?: number;
  LastEditedByAdminAt?: string | null;
  product_size_helper?: {
    data: { id: number; attributes: { Helper?: unknown } } | null;
  };
  Title: string;
  Slug?: string | null;
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
  ColorGalleries?: Array<{
    id: number;
    color: GenericRelation<{ id: number }>;
    Images: MediaField;
  }>;
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
  /** False when the product is InActive/Scheduled, soft-deleted, has no published
   *  priced variation, or has no cover image -- i.e. it would not appear on the
   *  public storefront even though it's still curated (mirrors the base
   *  Status/removedAt/variation/requireCoverImage predicate every "View all"
   *  listing enforces). Undefined = not checked (e.g. a just-added row, before
   *  the next reload). */
  isEligible?: boolean;
  /** Whether any variation currently has an active per-variation DiscountPrice.
   *  Only meaningful for the Discounts curation list. Does not detect a discount
   *  applied only via the separate general_discounts relation -- see the comment
   *  in getProductSummariesByIds. */
  isDiscounted?: boolean;
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
export async function getProductSummariesByIds(
  ids: number[],
): Promise<ProductSummary[]> {
  if (ids.length === 0) return [];

  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += PRODUCT_QUERY_MAX_LIMIT) {
    batches.push(ids.slice(i, i + PRODUCT_QUERY_MAX_LIMIT));
  }

  const responses = await Promise.all(
    batches.map((batch) => {
      const params = new URLSearchParams();
      batch.forEach((id, i) =>
        params.set(`filters[id][$in][${i}]`, String(id)),
      );
      params.set("pagination[limit]", String(batch.length));
      params.set("pagination[withCount]", "false");
      // Object-key populate throughout (`populate[CoverImage]=true`), not the array-index
      // form (`populate[0]=CoverImage`) -- mixing the two under the same `populate[...]`
      // tree confuses Strapi's qs normalizer and can silently drop keys.
      //
      // Deliberately NOT requesting product_variations.general_discounts here: verified
      // live against this endpoint (with and without a fields restriction, even with a
      // bare `populate=*`) that it never comes back, for any caller -- the internal
      // entityService populate the storefront query engine uses works, but this REST
      // list route does not surface it. Rather than chase that further, the discount
      // badge below only trusts DiscountPrice, which does come through reliably.
      params.set("populate[CoverImage]", "true");
      params.set("populate[product_variations][fields][0]", "IsPublished");
      params.set("populate[product_variations][fields][1]", "Price");
      params.set("populate[product_variations][fields][2]", "DiscountPrice");
      params.set("fields[0]", "Title");
      params.set("fields[1]", "id");
      params.set("fields[2]", "Status");
      params.set("fields[3]", "removedAt");
      const endpoint = `${ENDPOINTS.PRODUCT.PRODUCT}?${params.toString()}`;
      return apiClient.get(endpoint, { cache: "no-store" }) as Promise<any>;
    }),
  );

  const list = responses.flatMap((res: any) => res?.data ?? []);
  const idToIndex = new Map(ids.map((id, i) => [id, i]));
  const withOrder = list.map((raw: any) => {
    const id = raw.id;
    const attrs = raw.attributes ?? {};
    const title =
      typeof attrs.Title === "string" ? attrs.Title : `محصول #${id}`;
    let image: string | undefined;
    const cover = attrs.CoverImage as CoverImageField | undefined;
    if (cover?.data?.attributes?.url) {
      const url = cover.data.attributes.url;
      image = resolveAssetUrl(url) || undefined;
    }

    // A restricted (non-superadmin) admin user has this request's populate/fields
    // replaced server-side with a fixed shell populate (see product.ts controller's
    // find()), which still includes product_variations with its default scalar
    // fields, so eligibility and the DiscountPrice check below stay reliable for
    // every admin role.
    const variationsData = attrs.product_variations?.data;
    const variations = (
      Array.isArray(variationsData) ? variationsData : []
    ) as any[];
    const hasPublishedPricedVariation = variations.some((v) => {
      const vAttrs = v?.attributes ?? v ?? {};
      return Boolean(vAttrs.IsPublished) && Number(vAttrs.Price ?? 0) > 0;
    });
    const isEligible =
      attrs.Status === "Active" &&
      !attrs.removedAt &&
      hasPublishedPricedVariation &&
      Boolean(cover?.data);
    // Per-variation DiscountPrice only -- general-discount-only price cuts (a discount
    // applied via the separate general_discounts relation, with no DiscountPrice set on
    // the variation itself) won't be reflected here; see the populate comment above.
    // The public storefront query is unaffected, since it reads discounts straight from
    // the database rather than through this admin listing endpoint.
    const isDiscounted = variations.some((v) => {
      const vAttrs = v?.attributes ?? v ?? {};
      const price = Number(vAttrs.Price ?? 0);
      const discountPrice = Number(vAttrs.DiscountPrice ?? 0);
      return discountPrice > 0 && discountPrice < price;
    });

    return {
      id,
      title,
      image,
      isEligible,
      isDiscounted,
      order: idToIndex.get(id) ?? 0,
    };
  });
  withOrder.sort((a: any, b: any) => a.order - b.order);
  return withOrder.map(
    ({ id, title, image, isEligible, isDiscounted }: any) => ({
      id,
      title,
      image,
      isEligible,
      isDiscounted,
    }),
  );
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
    ids.forEach((id, index) =>
      params.set(`filters[id][$in][${index}]`, String(id)),
    );
    params.set("pagination[limit]", String(Math.max(ids.length, 4)));

    const res = (await apiClient.get(
      `${ENDPOINTS.PRODUCT.PRODUCT}?${params.toString()}`,
      {
        cache: "no-store",
      },
    )) as any;
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

  const res = (await apiClient.get(
    `${ENDPOINTS.PRODUCT.PRODUCT}?${params.toString()}`,
    {
      cache: "no-store",
    },
  )) as any;
  return formatProductsToCardProps(res?.data ?? []).slice(0, 4);
}
