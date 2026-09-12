import { Suspense } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { PRODUCT_COLLECTION_TAG, PRODUCT_TAG } from "@/constants/cacheTags";
import PLPHeroBanner from "@/components/PLP/HeroBanner";
import PLPList from "@/components/PLP/List";
import PageContainer from "@/components/layout/PageContainer";
import ProductListSkeleton from "@/components/Skeletons/ProductListSkeleton";
import AsyncSidebarProducts from "@/components/PLP/List/AsyncSidebarProducts";
import SiteSearchTracker from "@/components/Analytics/SiteSearchTracker";
import CustomDimensionTracker from "@/components/Analytics/CustomDimensionTracker";
import { SkeletonBlock } from "@repo/ui/skeleton";
import { CollectionPageSchema } from "@/components/SEO/CollectionPageSchema";
import CategoryEditorialSection from "@/components/PLP/CategoryEditorialSection";
import type { PLPProduct as PLPListProduct } from "@/components/PLP/types";
import {
  buildCollectionItems,
  buildPLPPageCopy,
  getPLPCategoryContext,
  getPLPProducts,
  parsePLPQuery,
} from "@/services/product/plp";
import { getCategoryPlpHrefWithQuery } from "@/utils/plpRoutes";
import logger from "@/utils/logger";
import {
  getPublishedCategoryEditorial,
  isCanonicalCategoryEditorialView,
} from "@/services/product/categoryEditorial";

const PLP_PAGE_SIZE = 30;

/**
 * The grid is the expensive part of a PLP render and is identical for every
 * visitor sharing a filter/sort/page combination, so one render per 5s serves
 * all of them. The page itself stays dynamic — it reads `searchParams` — and
 * that is correct; the cached unit is this query, keyed by its arguments.
 *
 * 5s rather than the previous 120s fetch window because the `view=card`
 * projection carries `IsAvailable`/`InventoryCount`: this is strictly fresher
 * stock than before, not staler.
 *
 * Errors are intentionally left to propagate. `getPLPProducts` throws
 * `PLPProductsError`, and a rejected promise must not be cached as if it were
 * a result.
 */
async function getCachedPLPProducts(
  query: Parameters<typeof getPLPProducts>[0],
  categorySlugs: string[] | undefined,
) {
  "use cache: remote";
  cacheLife("storefrontLive");
  cacheTag(PRODUCT_TAG, PRODUCT_COLLECTION_TAG);
  return getPLPProducts(query, categorySlugs, PLP_PAGE_SIZE);
}

interface PLPPageViewProps {
  categorySlug?: string;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function toURLSearchParams(params: { [key: string]: string | string[] | undefined }) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((item) => searchParams.append(key, item));
    } else if (typeof value === "string") {
      searchParams.set(key, value);
    }
  }
  return searchParams;
}

export default async function PLPPageView({ categorySlug, searchParams }: PLPPageViewProps) {
  const params = await searchParams;
  const query = parsePLPQuery(params);

  if (!categorySlug && query.category) {
    const legacyCategory = await getPLPCategoryContext(query.category);
    if (!legacyCategory) {
      logger.warn(`[PLP] Invalid or non-existent category requested: ${query.category}`);
      notFound();
    }
    redirect(
      getCategoryPlpHrefWithQuery(legacyCategory.slug, toURLSearchParams(params), {
        resetPage: false,
      }),
    );
  }

  const categoryContext = categorySlug ? await getPLPCategoryContext(categorySlug) : undefined;

  if (categorySlug && !categoryContext) {
    logger.warn(`[PLP] Invalid or non-existent category requested: ${categorySlug}`);
    notFound();
  }

  const resolvedCategoryContext = categoryContext ?? undefined;
  const shouldLoadEditorial = Boolean(
    resolvedCategoryContext?.slug && isCanonicalCategoryEditorialView(query),
  );
  const [productResult, editorial] = await Promise.all([
    getCachedPLPProducts(query, resolvedCategoryContext?.categorySlugs),
    shouldLoadEditorial && resolvedCategoryContext?.slug
      ? getPublishedCategoryEditorial(resolvedCategoryContext.slug)
      : Promise.resolve(null),
  ]);
  const { products, pagination } = productResult;
  const sidebarSlot = (
    <Suspense
      key="plp-sidebar-slot"
      fallback={
        <div className="flex flex-col gap-7">
          <SkeletonBlock tone="light" className="h-20 rounded" />
          <SkeletonBlock tone="light" className="h-20 rounded" />
        </div>
      }
    >
      <AsyncSidebarProducts />
    </Suspense>
  );

  const { pageName, pageDescription, url } = buildPLPPageCopy(query, resolvedCategoryContext);
  const collectionName = editorial?.title || pageName;
  const collectionDescription = editorial?.seoDescription || pageDescription;
  const collectionItems = buildCollectionItems(products);

  return (
    <PageContainer className="space-y-6 pb-20 pt-6">
      {query.search ? (
        <SiteSearchTracker query={query.search} resultCount={pagination.total} page={query.page} />
      ) : null}
      {resolvedCategoryContext?.slug ? (
        <CustomDimensionTracker dimension="category_id" value={resolvedCategoryContext.slug} />
      ) : null}

      {products.length > 0 && (
        <CollectionPageSchema
          name={collectionName}
          description={collectionDescription}
          url={url}
          items={collectionItems}
          itemCount={pagination.total}
        />
      )}

      {!query.search && <PLPHeroBanner initialTitle={resolvedCategoryContext?.title} />}

      {resolvedCategoryContext?.title ? (
        <h1 className="text-xl font-bold leading-8 text-neutral-900 sm:text-2xl">
          {resolvedCategoryContext.title}
        </h1>
      ) : null}

      <Suspense fallback={<ProductListSkeleton />}>
        <PLPList
          products={products as PLPListProduct[]}
          pagination={pagination}
          category={resolvedCategoryContext?.slug}
          allCategories={resolvedCategoryContext?.allCategories ?? []}
          searchQuery={query.search}
          sidebarSlot={sidebarSlot}
        />
      </Suspense>

      {editorial ? <CategoryEditorialSection editorial={editorial} /> : null}
    </PageContainer>
  );
}
