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
import { cacheLife, cacheTag } from "next/cache";
import { ENDPOINTS, getStrapiServerUrl } from "@/constants/api";
import {
  PRODUCT_COLLECTION_TAG,
  PRODUCT_TAG,
  productIdTag,
  productSlugTag,
} from "@/constants/cacheTags";
import { fetchCatalogJson, CatalogTransportError } from "@/lib/catalog-transport";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { SITE_NAME, SITE_URL } from "@/config/site";
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
import { normalizeProductDetail } from "../normalizeProductDetail";
import {
  fetchPdpProduct,
  PdpProductUnavailableError,
  type ProductLookupResult,
} from "@/services/product/pdp-lookup";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

const PDP_REVALIDATE_SECONDS = 30;
const PDP_ID_FALLBACK_POPULATE_QUERY =
  "populate[0]=CoverImage&populate[1]=Media&populate[2]=product_main_category&populate[3]=product_tags&populate[4]=product_variations&populate[5]=product_variations.product_stock&populate[6]=product_variations.product_variation_color&populate[7]=product_variations.product_variation_size&populate[8]=product_variations.product_variation_model&populate[9]=product_other_categories&populate[10]=product_size_helper&populate[11]=Files&populate[12]=product_faqs";

/**
 * How a product lookup failed. The PDP must only render a 404 for `missing`;
 * every other outcome is an infrastructure problem and has to reach the error
 * boundary so a transient backend fault is never cached as "no such product".
 */
const decodeProductSlug = (slug: string) => canonicalProductSlug(slug);

const stripHtml = (value: unknown) =>
  String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const truncate = (value: string, maxLength: number) =>
  value.length > maxLength ? value.slice(0, maxLength).trim() : value;

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

/**
 * Shared across replicas, not just across one render.
 *
 * The fetch below was already cached (`next.revalidate`), which is why Strapi
 * stayed idle under load — but the *render* was not, so 4k concurrent visitors
 * to one PDP produced ~1 API call and ~4k full renders of a ~1MB page. That is
 * what saturated the frontend while `api` sat at 0.26 of 32 cores.
 *
 * `storefrontLive` is a 5s window. This payload carries stock and price
 * (`view=shell` populates `product_stock`), so the window is deliberately
 * shorter than the 30s fetch revalidate it supersedes: strictly fresher than
 * before, while still collapsing a stampede into one render per URL per 5s.
 */
async function getRemoteCachedPdpProduct(decodedSlug: string): Promise<ProductLookupResult> {
  "use cache: remote";
  cacheLife("storefrontLive");
  cacheTag(PRODUCT_TAG, productSlugTag(decodedSlug));
  const lookup = await fetchPdpProduct(decodedSlug, PDP_REVALIDATE_SECONDS);

  // A transient infra fault (timeout, 5xx, malformed payload) must throw
  // rather than return here. Next only writes a "use cache" entry when the
  // function *returns* — a throw propagates without being persisted. Returning
  // this outcome instead once wrote a single Strapi blip into the shared Redis
  // cache, so every visitor to this URL, across every replica, replayed the
  // same "product unavailable" throw (and the page body's crash) for the full
  // `storefrontLive` cache life instead of the next request simply retrying.
  if (lookup.errorDetails?.failure === "unavailable") {
    throw new PdpProductUnavailableError(lookup.errorDetails);
  }

  return lookup;
}

// React `cache` on top so `generateMetadata` and the page body share one
// result within a single request rather than each consulting the remote cache.
const getCachedPdpProduct = cache(async (decodedSlug: string): Promise<ProductLookupResult> => {
  try {
    return await getRemoteCachedPdpProduct(decodedSlug);
  } catch (error) {
    if (error instanceof PdpProductUnavailableError) {
      return { product: null, errorDetails: { ...error.details, error } };
    }
    throw error;
  }
});

/**
 * Related rails are identical for every visitor, so one render per 5s serves
 * all of them. Cached on the same `storefrontLive` window as the shell because
 * the `view=card` projection also carries `IsAvailable`/`InventoryCount`.
 */
async function getCachedRelatedProducts(
  mainCategoryId: string,
  otherCategoryIds: string[],
  productId: string,
) {
  "use cache: remote";
  cacheLife("storefrontLive");
  cacheTag(PRODUCT_TAG, PRODUCT_COLLECTION_TAG, productIdTag(productId));
  return Promise.allSettled([
    getRelatedProductsByMainCategory(mainCategoryId, productId),
    getRelatedProductsByOtherCategories(otherCategoryIds, productId),
  ]);
}

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
    const results = await getCachedRelatedProducts(mainCategoryId, otherCategoryIds, productId);

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

/**
 * Reviews are public, identical for every visitor, and carry no stock or price.
 *
 * The explicit `"default"` opts out of the service's `no-store` default, which
 * exists for browser callers that must see their own just-posted review. That
 * default also makes the shared api-client append a `_cb` timestamp, producing
 * a unique URL per request — which is why the production API logs showed the
 * same review query for the same product repeated hundreds of times per second
 * during the load test.
 */
async function getCachedProductReviews(productId: string) {
  "use cache: remote";
  cacheLife("storefrontLive");
  cacheTag(PRODUCT_TAG, productIdTag(productId));
  return productReviewService.getProductReviews(
    productId,
    { page: 1, pageSize: 10, sort: "createdAt:desc" },
    { cache: "default" },
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
  let reviewTotalPages = 1;

  if (productId) {
    try {
      const response = await getCachedProductReviews(productId);
      productReviews = response.data || [];
      reviewTotalPages = response.meta?.totalPages || 1;
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
        initialTotalPages={reviewTotalPages}
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
  const catalogDeadlineAt = Date.now() + 15_000;
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
      throw errorDetails.error ?? new Error(errorDetails.message || "Product not found");
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
      ...errorDetails,
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
    if (isNumericSlug && !productData && errorDetails.failure === "missing") {
      logger.info("[PDP] Attempting ID-based fallback", { decodedSlug });
      try {
        // Server-safe fetch with the same shell fields used by the slug lookup.
        const fallbackEndpoint = `${ENDPOINTS.PRODUCT.PRODUCT}/${decodedSlug}?${PDP_ID_FALLBACK_POPULATE_QUERY}`;
        const fallbackUrl = `${strapiBaseUrl}${fallbackEndpoint}`;

        const {
          response: fallbackResponse,
          data: fallbackData,
          requestId,
        } = await fetchCatalogJson<{ data?: unknown }>(
          fallbackUrl,
          {
            headers: { Accept: "application/json" },
            next: {
              revalidate: PDP_REVALIDATE_SECONDS,
              tags: [PRODUCT_TAG, productIdTag(decodedSlug)],
            },
          },
          "pdp_id",
          { deadlineAt: catalogDeadlineAt },
        );
        if (!fallbackResponse.ok && fallbackResponse.status !== 404) {
          errorDetails = {
            failure: "unavailable",
            failureStage: "response_status",
            status: fallbackResponse.status,
            requestId,
          };
        } else if (fallbackResponse.ok && !fallbackData?.data) {
          errorDetails = {
            failure: "unavailable",
            failureStage: "response_normalization",
            status: fallbackResponse.status,
            requestId,
          };
        }
        if (fallbackData?.data) {
          productData = normalizeProductDetail(fallbackData.data);

          // Check if product is trashed
          const status = productData?.attributes?.Status;
          const removedAt = productData?.attributes?.removedAt;
          if (productData && (status !== "Active" || removedAt)) {
            productData = null;
            errorDetails = { failure: "missing", status: 404 };
          }

          logger.info("[PDP] Product found via ID fallback", { productId: productData?.id });
        }
      } catch (idError: unknown) {
        errorDetails = {
          failure: "unavailable",
          failureStage:
            idError instanceof CatalogTransportError
              ? idError.failureStage
              : "response_normalization",
          status: idError instanceof CatalogTransportError ? idError.status : undefined,
          requestId: idError instanceof CatalogTransportError ? idError.requestId : undefined,
          cause: idError instanceof CatalogTransportError ? idError.cause : idError,
        };
        logger.error("[PDP] ID fallback also failed", {
          decodedSlug,
          failureStage: errorDetails.failureStage,
          status: errorDetails.status,
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

    throw errorDetails.error ?? new PdpProductUnavailableError(errorDetails);
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
