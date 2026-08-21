import Breadcrumb from "@/components/Kits/Breadcrumb";
import Hero from "@/components/PDP/Hero";
import OffersListHomePage from "@/components/PDP/OffersListHomePage";
import FavoriteIcon from "@/components/PDP/Icons/FavoriteIcon";
import PDPComment from "@/components/PDP/Comment";
import PageContainer from "@/components/layout/PageContainer";
import {
  productReviewService,
  type ProductReview,
} from "@/services/product/product-review.service";
import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { cache, Suspense } from "react";
import { ENDPOINTS, getStrapiServerUrl } from "@/constants/api";
import { PRODUCT_TAG, productIdTag, productSlugTag } from "@/constants/cacheTags";
import { fetchWithTimeout } from "@repo/api";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { SITE_NAME } from "@/config/site";
import logger from "@/utils/logger";
import { ProductSchema } from "@/components/SEO/ProductSchema";
import { BreadcrumbSchema } from "@/components/SEO/BreadcrumbSchema";
import { ReviewSchema } from "@/components/SEO/ReviewSchema";
import ViewItemTracker from "@/components/Analytics/ViewItemTracker";
import type { ProductDetail } from "@/services/product/product";
import {
  getRelatedProductsByMainCategory,
  getRelatedProductsByOtherCategories,
} from "@/services/product/product";
import { getCategoryPlpHref } from "@/utils/plpRoutes";
import {
  buildCanonicalPdpPath,
  canonicalProductSlug,
  shouldRedirectToCanonicalSlug,
} from "@/utils/productSlug";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

const PDP_REVALIDATE_SECONDS = 30;
/**
 * Without this the PDP fetch had no timeout at all, so a hung Strapi held the
 * render open until the platform killed it — which is how a slow backend
 * surfaced as a gateway 504 rather than a retryable error.
 *
 * Kept meaningfully under the observed ~16s gateway budget so the timeout fires
 * first and the customer gets the retry boundary instead of a raw 504. The warm
 * by-slug call measures ~1.8s, so this is generous headroom.
 */
const PDP_FETCH_TIMEOUT_MS = 10000;
const PDP_PRODUCT_SHELL_QUERY = "view=shell";
const PDP_ID_FALLBACK_POPULATE_QUERY =
  "populate[0]=CoverImage&populate[1]=Media&populate[2]=product_main_category&populate[3]=product_tags&populate[4]=product_variations&populate[5]=product_variations.product_stock&populate[6]=product_variations.product_variation_color&populate[7]=product_variations.product_variation_size&populate[8]=product_variations.product_variation_model&populate[9]=product_other_categories&populate[10]=product_size_helper&populate[11]=Files&populate[12]=product_faqs";

/**
 * How a product lookup failed. The PDP must only render a 404 for `missing`;
 * every other outcome is an infrastructure problem and has to reach the error
 * boundary so a transient backend fault is never cached as "no such product".
 */
type ProductLookupFailure = "missing" | "unavailable";

type ProductLookupResult = {
  product: ProductDetail | null;
  errorDetails?: {
    message?: string;
    status?: number;
    endpoint?: string;
    failure?: ProductLookupFailure;
  };
};

const decodeProductSlug = (slug: string) => canonicalProductSlug(slug);

const stripHtml = (value: unknown) =>
  String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const truncate = (value: string, maxLength: number) =>
  value.length > maxLength ? value.slice(0, maxLength).trim() : value;

const normalizeRelation = (rel: any, isVariation = false): any => {
  if (!rel) return null;

  if (rel.data) return rel;

  if (Array.isArray(rel)) {
    return {
      data: rel.map((item: any) => {
        if (item.attributes) {
          if (isVariation) {
            const {
              product_stock,
              product_variation_color,
              product_variation_size,
              product_variation_model,
              ...rest
            } = item.attributes;

            return {
              ...item,
              attributes: {
                ...rest,
                product_stock: normalizeRelation(product_stock),
                product_variation_color: normalizeRelation(product_variation_color),
                product_variation_size: normalizeRelation(product_variation_size),
                product_variation_model: normalizeRelation(product_variation_model),
              },
            };
          }

          return item;
        }

        const {
          id,
          product_stock,
          product_variation_color,
          product_variation_size,
          product_variation_model,
          ...rest
        } = item;
        const normalized: any = { id, attributes: rest };

        if (isVariation) {
          normalized.attributes.product_stock = normalizeRelation(product_stock);
          normalized.attributes.product_variation_color =
            normalizeRelation(product_variation_color);
          normalized.attributes.product_variation_size = normalizeRelation(product_variation_size);
          normalized.attributes.product_variation_model =
            normalizeRelation(product_variation_model);
        }

        return normalized;
      }),
    };
  }

  if (rel.id !== undefined) {
    const { id, ...rest } = rel;
    return {
      data: { id, attributes: rest },
    };
  }

  return null;
};

const normalizeProductDetail = (rawProduct: any): ProductDetail | null => {
  if (!rawProduct) return null;

  if (rawProduct.attributes) {
    return {
      ...rawProduct,
      attributes: {
        ...rawProduct.attributes,
        product_main_category: normalizeRelation(rawProduct.attributes.product_main_category),
        product_other_categories: normalizeRelation(rawProduct.attributes.product_other_categories),
        product_variations: normalizeRelation(rawProduct.attributes.product_variations, true),
        product_reviews: normalizeRelation(rawProduct.attributes.product_reviews),
        product_tags: normalizeRelation(rawProduct.attributes.product_tags),
        CoverImage: normalizeRelation(rawProduct.attributes.CoverImage),
        Media: normalizeRelation(rawProduct.attributes.Media),
        Files: normalizeRelation(rawProduct.attributes.Files),
        product_size_helper: normalizeRelation(rawProduct.attributes.product_size_helper),
      },
    };
  }

  const {
    id,
    product_main_category,
    product_other_categories,
    product_variations,
    product_reviews,
    product_tags,
    CoverImage,
    Media,
    Files,
    product_size_helper,
    ...rest
  } = rawProduct;

  return {
    id,
    attributes: {
      ...rest,
      product_main_category: normalizeRelation(product_main_category),
      product_other_categories: normalizeRelation(product_other_categories),
      product_variations: normalizeRelation(product_variations, true),
      product_reviews: normalizeRelation(product_reviews),
      product_tags: normalizeRelation(product_tags),
      CoverImage: normalizeRelation(CoverImage),
      Media: normalizeRelation(Media),
      Files: normalizeRelation(Files),
      product_size_helper: normalizeRelation(product_size_helper),
    },
  } as ProductDetail;
};

const isActiveProduct = (product: ProductDetail | null) =>
  product?.attributes?.Status === "Active" && !product?.attributes?.removedAt;

/**
 * Whether a lookup proves the product has no public PDP.
 *
 * True for a genuine backend 404 and for a product that exists but is inactive
 * or soft-deleted. Deliberately false for every transport/server failure, so an
 * outage can never be published as a durable 404.
 */
const isMissingProduct = (lookup: ProductLookupResult) => {
  if (lookup.errorDetails?.failure === "missing") return true;
  if (lookup.product && !isActiveProduct(lookup.product)) return true;
  return false;
};

const fetchPdpProduct = async (
  decodedSlug: string,
  revalidateSeconds: number,
): Promise<ProductLookupResult> => {
  const strapiBaseUrl = getStrapiServerUrl();
  const encodedSlug = encodeURIComponent(decodedSlug);
  const endpoint = `${ENDPOINTS.PRODUCT.PRODUCT}/by-slug/${encodedSlug}?${PDP_PRODUCT_SHELL_QUERY}`;
  const apiUrl = `${strapiBaseUrl}${endpoint}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(apiUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeoutMs: PDP_FETCH_TIMEOUT_MS,
      // Tags let a product mutation invalidate this entry without having to
      // reproduce Next's exact encoding of the Persian slug in a path.
      next: {
        revalidate: revalidateSeconds,
        tags: [PRODUCT_TAG, productSlugTag(decodedSlug)],
      },
    });
  } catch (error) {
    // Timeout / DNS / TLS / connection reset. Never a 404.
    return {
      product: null,
      errorDetails: {
        message: (error as Error)?.message || "Product request failed",
        endpoint: apiUrl,
        failure: "unavailable",
      },
    };
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    return {
      product: null,
      errorDetails: {
        message: errorData?.error?.message || `HTTP ${response.status}: ${response.statusText}`,
        status: response.status,
        endpoint: apiUrl,
        // Only a literal 404 means the product does not exist. 4xx/5xx of any
        // other shape is a backend fault and must not become a cached 404.
        failure: response.status === 404 ? "missing" : "unavailable",
      },
    };
  }

  const data = await response.json();
  const product = normalizeProductDetail(data?.data);

  // A 200 with no usable payload is a malformed response, not an absent product.
  if (!product) {
    return {
      product: null,
      errorDetails: {
        message: "Product response contained no data",
        status: response.status,
        endpoint: apiUrl,
        failure: "unavailable",
      },
    };
  }

  return { product, errorDetails: { endpoint: apiUrl } };
};

const getCachedPdpProduct = cache((decodedSlug: string) =>
  fetchPdpProduct(decodedSlug, PDP_REVALIDATE_SECONDS),
);

async function PDPRelatedProductsSection({
  mainCategoryId,
  otherCategoryIds,
  productId,
}: {
  mainCategoryId: string;
  otherCategoryIds: string[];
  productId: string;
}) {
  let sameMainCategoryProducts: any[] = [];
  let otherCategoriesProducts: any[] = [];

  try {
    const results = await Promise.allSettled([
      getRelatedProductsByMainCategory(mainCategoryId, productId),
      getRelatedProductsByOtherCategories(otherCategoryIds, productId),
    ]);

    if (results[0].status === "fulfilled") {
      sameMainCategoryProducts = results[0].value;
    } else {
      logger.error("Error fetching main category products", {
        error: String(results[0].reason),
      });
    }

    if (results[1].status === "fulfilled") {
      otherCategoriesProducts = results[1].value;
    } else {
      logger.error("Error fetching other categories products", {
        error: String(results[1].reason),
      });
    }
  } catch (error) {
    logger.error("Error fetching related products", { error: String(error) });
  }

  if (sameMainCategoryProducts.length === 0 && otherCategoriesProducts.length === 0) {
    return null;
  }

  return (
    <>
      {sameMainCategoryProducts.length > 0 && (
        <OffersListHomePage
          icon={<FavoriteIcon />}
          title="شاید بپسندید"
          products={sameMainCategoryProducts}
        />
      )}

      {otherCategoriesProducts.length > 0 && (
        <OffersListHomePage
          icon={<FavoriteIcon />}
          title="محصولات مشابه"
          products={otherCategoriesProducts}
        />
      )}
    </>
  );
}

async function PDPReviewsSection({
  productId,
  productData,
  productTitle,
  productUrl,
  averageRating,
  reviewCount,
}: {
  productId: string;
  productData: ProductDetail;
  productTitle: string;
  productUrl: string;
  averageRating: number;
  reviewCount: number;
}) {
  let productReviews: ProductReview[] = [];

  if (productId) {
    try {
      const response = await productReviewService.getProductReviews(productId, {
        page: 1,
        pageSize: 10,
        sort: "createdAt:desc",
      });
      productReviews = response.data || [];
    } catch (error) {
      logger.error("Error fetching product reviews", { productId, error: String(error) });
    }
  }

  return (
    <>
      {reviewCount > 0 && averageRating > 0 && (
        <ReviewSchema
          productName={productTitle}
          productUrl={productUrl}
          averageRating={averageRating}
          reviewCount={reviewCount}
          reviews={productReviews}
        />
      )}

      <PDPComment
        productId={productId}
        productReviews={productReviews}
        rating={averageRating}
        rateCount={reviewCount}
        productData={productData}
      />
    </>
  );
}

function RelatedProductsFallback() {
  return (
    <div className="flex min-h-[360px] flex-col gap-4" dir="rtl" aria-hidden="true">
      <div className="h-8 w-48 animate-pulse rounded bg-slate-100" />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-72 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    </div>
  );
}

function ReviewsFallback() {
  return (
    <div className="min-h-[420px] rounded-lg bg-slate-50 p-5" dir="rtl" aria-hidden="true">
      <div className="mb-5 h-8 w-56 animate-pulse rounded bg-slate-100" />
      <div className="grid gap-4 md:grid-cols-[1fr_386px]">
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-lg bg-white" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-lg bg-white" />
      </div>
    </div>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://new.infinitycolor.co";

  const decodedSlug = decodeProductSlug(slug);
  const isNumericId = /^\d+$/.test(decodedSlug);
  const requestedUrl = `${SITE_URL}/pdp/${encodeURIComponent(decodedSlug)}`;

  // The lookup and the 404 decision deliberately sit OUTSIDE the try/catch below.
  //
  // `notFound()` signals by throwing. While this lived inside the try, the catch
  // swallowed that signal and returned "محصول یافت نشد" metadata instead, so the
  // response committed as HTTP 200 and the page body's later notFound() could no
  // longer change the status. Result: every missing product — and every
  // nonexistent slug — was served as a soft-404 that crawlers read as a real page.
  //
  // `getCachedPdpProduct` is wrapped in React `cache`, so the page body reuses
  // this lookup rather than issuing a second request.
  const lookup = await getCachedPdpProduct(decodedSlug);
  if (isMissingProduct(lookup)) {
    notFound();
  }

  const product: ProductDetail | null =
    lookup.product && isActiveProduct(lookup.product) ? lookup.product : null;

  if (!product) {
    // Not missing, so this is an infrastructure failure. Emit placeholder,
    // non-indexable metadata and let the page body throw into the error
    // boundary — a transient backend fault must never become a durable 404.
    logger.warn("[PDP Metadata] Product unavailable for metadata", {
      slug,
      status: lookup.errorDetails?.status,
      failure: lookup.errorDetails?.failure,
    });
    return {
      title: "محصول یافت نشد",
      description: `محصول مورد نظر در ${SITE_NAME} یافت نشد.`,
      robots: {
        index: false,
        follow: false,
      },
      alternates: { canonical: requestedUrl },
    };
  }

  try {
    const titleRaw = product.attributes?.Title?.trim() || "";
    const title = titleRaw || `محصول ${product.id || decodedSlug}`;
    const descRaw = stripHtml(product.attributes?.Description);
    const description = descRaw
      ? truncate(descRaw, 160)
      : `خرید ${titleRaw || "محصول"} از ${SITE_NAME}`;
    const imageUrl = product.attributes?.CoverImage?.data?.attributes?.url
      ? resolveAssetUrl(product.attributes.CoverImage.data.attributes.url) || undefined
      : undefined;

    // Get price info for OpenGraph
    const variations = product?.attributes?.product_variations?.data || [];
    const prices = variations
      .map((v: any) => {
        const price = parseFloat(v?.attributes?.Price || "0");
        const discountPrice = parseFloat(v?.attributes?.DiscountPrice || "0");
        return discountPrice > 0 ? discountPrice : price;
      })
      .filter((p) => p > 0);
    const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
    const hasStock = variations.length > 0;

    // Build OpenGraph object with product-specific properties
    // Note: Next.js Metadata API only supports: "website", "article", "book", "profile"
    // Product-specific properties are added as custom metadata
    const openGraphBase: any = {
      title,
      description,
      type: "website",
      url: requestedUrl,
      siteName: SITE_NAME,
      locale: "fa_IR",
      images: imageUrl
        ? [
            {
              url: imageUrl,
              width: 1200,
              height: 630,
              alt: titleRaw,
            },
          ]
        : undefined,
    };

    // Add product-specific OpenGraph properties if data exists
    if (minPrice > 0) {
      openGraphBase["product:price:amount"] = minPrice.toString();
      openGraphBase["product:price:currency"] = "IRR";
    }
    if (hasStock) {
      openGraphBase["product:availability"] = "in stock";
    }

    return {
      title,
      description,
      keywords: [titleRaw, "خرید", "فروشگاه آنلاین", "اینفینیتی"],
      openGraph: openGraphBase,
      twitter: {
        card: "summary_large_image",
        title,
        description,
        images: imageUrl ? [imageUrl] : undefined,
      },
      alternates: {
        canonical: requestedUrl,
      },
      robots: isNumericId
        ? {
            index: false,
            follow: false,
          }
        : undefined,
    };
  } catch (error) {
    logger.error("[PDP Metadata] Error fetching product for metadata", {
      slug,
      error: String(error),
    });
    return {
      title: "محصول یافت نشد",
      description: `محصول مورد نظر در ${SITE_NAME} یافت نشد.`,
      robots: {
        index: false,
        follow: false,
      },
      alternates: { canonical: requestedUrl },
    };
  }
}

export default async function PDP({ params }: { params: Promise<{ slug: string }> }) {
  // Handle both Promise<{slug}> and direct {slug} parameter formats
  const { slug } = await params;

  // Log for debugging (server-side logs appear in terminal)
  logger.info("[PDP] Fetching product", { slug, timestamp: new Date().toISOString() });
  const strapiBaseUrl = getStrapiServerUrl();

  // Verify the server-side Strapi URL is available (critical for server components)
  if (!strapiBaseUrl || strapiBaseUrl === "undefined") {
    const errorMsg = `Strapi server URL is not configured. Current value: ${strapiBaseUrl}`;
    logger.error("[PDP] Configuration error", {
      errorMsg,
      internalEnvVar: process.env.STRAPI_INTERNAL_URL,
      publicEnvVar: process.env.NEXT_PUBLIC_API_BASE_URL,
    });
    throw new Error(errorMsg);
  }

  // Decode slug first (Next.js may pass it already encoded), then encode for URL
  // This prevents double-encoding issues
  const decodedSlug = decodeProductSlug(slug);

  // Fetch product data from API using server-safe fetch
  let productData: ProductDetail | null = null;
  let errorDetails: NonNullable<ProductLookupResult["errorDetails"]> = {};

  try {
    logger.info("[PDP] Making API request", {
      originalSlug: slug,
      decodedSlug,
      apiBaseUrl: strapiBaseUrl,
      hasApiBaseUrl: !!strapiBaseUrl,
    });

    const lookup = await getCachedPdpProduct(decodedSlug);
    errorDetails = {
      ...errorDetails,
      ...lookup.errorDetails,
    };

    logger.info("[PDP] API response received", {
      status: lookup.errorDetails?.status || 200,
      ok: Boolean(lookup.product),
    });

    if (!lookup.product) {
      if (lookup.errorDetails) {
        errorDetails = lookup.errorDetails;
      }
      logger.error("[PDP] API request failed", errorDetails);
      throw new Error(errorDetails.message || "Product not found");
    }

    productData = lookup.product;

    // Check if product is trashed (removedAt is not null)
    const status = productData?.attributes?.Status;
    const removedAt = productData?.attributes?.removedAt;
    if (productData && (status !== "Active" || removedAt)) {
      errorDetails = {
        message: "Product has been removed or is inactive",
        status: 404,
        endpoint: lookup.errorDetails?.endpoint,
        failure: "missing",
      };
      logger.warn("[PDP] Product is inactive or removed", {
        slug,
        productId: productData?.id,
        status,
        removedAt,
      });
      throw new Error("Product not found");
    }

    logger.info("[PDP] Product found successfully", {
      productId: productData?.id,
      title: productData?.attributes?.Title?.substring(0, 50),
      hasAttributes: !!productData?.attributes,
    });
  } catch (err: any) {
    errorDetails = {
      message: err?.message || String(err),
      status: err?.status || (err as any)?.response?.status || errorDetails.status,
      endpoint:
        errorDetails.endpoint ||
        `${strapiBaseUrl}${ENDPOINTS.PRODUCT.PRODUCT}/by-slug/${encodeURIComponent(decodedSlug)}`,
      // Preserve the classification the lookup already made. An unclassified
      // throw from this block is an unexpected fault, so it defaults to
      // "unavailable" — the safe side, since it renders a retry instead of
      // caching a 404.
      failure: errorDetails.failure ?? "unavailable",
    };
    logger.error("[PDP] Error fetching product", {
      slug,
      error: errorDetails.message,
      status: errorDetails.status,
      stack: err?.stack,
    });

    // Try ID fallback if slug looks like a number
    // Use server-safe fetch instead of getProductById (which uses apiClient with localStorage)
    const isNumericSlug = /^\d+$/.test(decodedSlug);
    if (isNumericSlug && !productData) {
      logger.info("[PDP] Attempting ID-based fallback", { decodedSlug });
      try {
        // Server-safe fetch with the same shell fields used by the slug lookup.
        const fallbackEndpoint = `${ENDPOINTS.PRODUCT.PRODUCT}/${decodedSlug}?${PDP_ID_FALLBACK_POPULATE_QUERY}`;
        const fallbackUrl = `${strapiBaseUrl}${fallbackEndpoint}`;

        const fallbackResponse = await fetchWithTimeout(fallbackUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          timeoutMs: PDP_FETCH_TIMEOUT_MS,
          next: {
            revalidate: PDP_REVALIDATE_SECONDS,
            tags: [PRODUCT_TAG, productIdTag(decodedSlug)],
          },
        });

        if (!fallbackResponse.ok) {
          throw new Error(`HTTP ${fallbackResponse.status}: ${fallbackResponse.statusText}`);
        }

        const fallbackData = await fallbackResponse.json();

        if (fallbackData?.data) {
          productData = normalizeProductDetail(fallbackData.data);

          // Check if product is trashed
          const status = productData?.attributes?.Status;
          const removedAt = productData?.attributes?.removedAt;
          if (productData && (status !== "Active" || removedAt)) {
            throw new Error("Product has been removed or is inactive");
          }

          logger.info("[PDP] Product found via ID fallback", { productId: productData?.id });
        }
      } catch (idError: any) {
        logger.error("[PDP] ID fallback also failed", {
          decodedSlug,
          error: idError?.message || String(idError),
          status: idError?.status,
          stack: idError?.stack,
        });
      }
    }
  }

  // Missing/inactive products are durable 404s. Transport/server failures must
  // reach the route boundary so the customer gets a retry action instead of a
  // misleading "product not found" message.
  //
  // The decision is keyed on the structured `failure` discriminator, never on
  // substring-matching the error text: a database timeout whose message happened
  // to contain "not found" used to be classified as a durable 404 and cached as
  // one.
  if (!productData || !productData.attributes) {
    if (errorDetails.failure === "missing") {
      notFound();
    }

    throw new Error("PRODUCT_DATA_UNAVAILABLE");
  }

  // SEO: prior slug forms (percent-encoded imports, renamed slugs) permanently
  // redirect to the decoded canonical Slug. Candidate-set / alias lookup already
  // resolved the product; this only normalizes the public URL.
  if (shouldRedirectToCanonicalSlug(slug, productData.attributes.Slug)) {
    permanentRedirect(buildCanonicalPdpPath(productData.attributes.Slug));
  }

  // Get category name from either Title or Name field (no fallback placeholder)
  const categoryName =
    productData.attributes.product_main_category?.data?.attributes?.Title ||
    productData.attributes.product_main_category?.data?.attributes?.Name ||
    "";

  const categorySlug = productData.attributes.product_main_category?.data?.attributes?.Slug || "";

  const productTitle = productData.attributes.Title || "";

  // Fetch related products
  const productId = productData.id?.toString() || "";
  const mainCategoryId = productData.attributes.product_main_category?.data?.id?.toString() || "";

  // Get IDs of other categories this product belongs to
  const otherCategoryIds =
    productData.attributes.product_other_categories?.data
      ?.map((cat) => cat.id?.toString())
      .filter(Boolean) || [];

  const breadcrumbItems = [
    {
      label: "صفحه اصلی",
      href: "/",
    },
    {
      label: categoryName,
      href: getCategoryPlpHref(categorySlug),
    },
    {
      label: productTitle,
    },
  ];

  const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://new.infinitycolor.co";
  const productUrl = `${SITE_URL}/pdp/${slug}`;
  const averageRating = productData.attributes.AverageRating || 0;
  const reviewCount = productData.attributes.RatingCount || 0;
  const variationPrices =
    productData.attributes.product_variations?.data
      ?.map((variation: any) => {
        const price = Number(
          variation?.attributes?.DiscountPrice || variation?.attributes?.Price || 0,
        );
        return Number.isFinite(price) ? price : 0;
      })
      .filter((price) => price > 0) || [];
  const minVisiblePrice = variationPrices.length > 0 ? Math.min(...variationPrices) : 0;

  return (
    <PageContainer variant="wide" className="flex flex-col gap-10 pb-16 pt-6">
      {/* JSON-LD Schemas for SEO */}
      <ViewItemTracker productId={productData.id || 0} price={minVisiblePrice} />
      {productData && <ProductSchema product={productData} slug={slug} />}
      <BreadcrumbSchema breadcrumbs={breadcrumbItems} />

      <div className="flex flex-col gap-3">
        <Breadcrumb breadcrumbs={breadcrumbItems} />

        <Hero productData={productData} productId={productId} />
      </div>

      <Suspense fallback={<RelatedProductsFallback />}>
        <PDPRelatedProductsSection
          mainCategoryId={mainCategoryId}
          otherCategoryIds={otherCategoryIds}
          productId={productId}
        />
      </Suspense>

      <Suspense fallback={<ReviewsFallback />}>
        <PDPReviewsSection
          productId={productId}
          productData={productData}
          productTitle={productTitle}
          productUrl={productUrl}
          averageRating={averageRating}
          reviewCount={reviewCount}
        />
      </Suspense>

      {/* <PDPHeroInfoFAQItem
        title="عنوان توضیحات سئو در این قسمت قرار می گیرد"
        content={productData.attributes.Description || ""}
      /> */}
    </PageContainer>
  );
}
