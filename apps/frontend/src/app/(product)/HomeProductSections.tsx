import { Suspense } from "react";
import Link from "next/link";
import { SkeletonBlock, SkeletonMedia, SkeletonText } from "@repo/ui/skeleton";
import NewIcon from "@/components/PDP/Icons/NewIcon";
import OffIcon from "@/components/PDP/Icons/OffIcon";
import OffersListHomePage from "@/components/PDP/OffersListHomePage";
import OffersListHomePageServerShell from "@/components/PDP/OffersListHomePageServerShell";
import Reveal from "@/components/Reveal";
import HomePromoBanners, { type HomePromoBanner } from "@/components/Home/PromoBanners";
import HomeGifPromoSection from "@/components/Home/HomeGifPromoSection";
import DiscountedShowcase from "@/components/Home/DiscountedShowcase";
import {
  getBatchedHomepageSections,
  getHomepageSections,
  getGifPromoProducts,
  getHomeSectionProducts,
  getProductsByIds,
  pickBatchedHomepageSection,
  type HomepageProductSectionId,
} from "@/services/product/homepage";
import { getCategoryPlpHref } from "@/utils/plpRoutes";
import type {
  HomeGifPromoAssignment,
  SuperAdminSettings,
} from "@/types/super-admin/settings";
import type { ProductCardProps } from "@/components/Product/Card";

const NEWEST_BACKGROUND_ELLIPSES = [
  "right-[-8%] top-[-18%] h-[230px] w-[390px] bg-[#8FB4FF] md:h-[300px] md:w-[520px] animate-orb-drift-a",
  "right-[22%] top-[8%] h-[180px] w-[320px] bg-[#FFE8F3] md:h-[240px] md:w-[430px] animate-orb-drift-b [animation-delay:-4s]",
  "left-[18%] bottom-[-24%] h-[220px] w-[410px] bg-[#8FB4FF] md:h-[290px] md:w-[560px] animate-orb-drift-c [animation-delay:-8s]",
  "right-[6%] bottom-[-16%] h-[210px] w-[360px] bg-[#FFE56A] md:h-[280px] md:w-[500px] animate-orb-drift-a [animation-delay:-5s]",
  "left-[36%] top-[-20%] h-[190px] w-[340px] bg-[#FFE56A] md:h-[260px] md:w-[460px] animate-orb-drift-b [animation-delay:-10s]",
  "left-[-10%] top-[18%] h-[240px] w-[420px] bg-[#E6F7F0] md:h-[320px] md:w-[570px] animate-orb-drift-c [animation-delay:-2s]",
  "left-[-4%] bottom-[8%] h-[190px] w-[340px] bg-[#FFE4C0] md:h-[270px] md:w-[470px] animate-orb-drift-a [animation-delay:-9s]",
  "left-[46%] bottom-[-20%] h-[200px] w-[380px] bg-[#FFE4C0] md:h-[280px] md:w-[520px] animate-orb-drift-b [animation-delay:-6s]",
  "right-[44%] top-[30%] h-[170px] w-[310px] bg-[#E6F7F0] md:h-[230px] md:w-[440px] animate-orb-drift-c [animation-delay:-12s]",
] as const;

type HomepageSectionsPromise = ReturnType<typeof getHomepageSections>;
type HomepageSectionsLoader = () => HomepageSectionsPromise;
type BatchedHomepageSectionsPromise = ReturnType<typeof getBatchedHomepageSections>;

function shouldUseProductServerShell(sectionId: HomepageProductSectionId): boolean {
  return process.env.HOME_PRODUCT_SERVER_SHELL_SECTION?.trim() === sectionId;
}

/**
 * Custom sections always pass an explicit target, so they never fall through to
 * the rail's own title-substring heuristic — a section titled «تخفیف ویژه» would
 * otherwise land on the discount PLP.
 */
function customSectionViewAllHref(
  assignment: HomeGifPromoAssignment,
  configuredHref: string,
): string {
  if (configuredHref) return configuredHref;
  if (assignment.mode === "category") {
    const slug = assignment.categorySlug?.trim();
    if (slug) return getCategoryPlpHref(slug);
  }
  return "/plp";
}

function HomeOffersList({
  sectionId,
  icon,
  title,
  products,
  viewAllHref,
}: {
  sectionId: HomepageProductSectionId;
  icon: React.ReactNode;
  title: string;
  products: ProductCardProps[];
  viewAllHref?: string;
}) {
  if (sectionId === "discounted") {
    return <DiscountedShowcase products={products} />;
  }

  const Component = shouldUseProductServerShell(sectionId)
    ? OffersListHomePageServerShell
    : OffersListHomePage;

  return <Component icon={icon} title={title} products={products} viewAllHref={viewAllHref} />;
}

function ProductCardsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid min-w-0 grid-cols-2 gap-4 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 3xl:grid-cols-5 3xl:gap-5 4xl:grid-cols-6">
      {[...Array(count)].map((_, index) => (
        <div key={index} className="space-y-3">
          <SkeletonMedia aspect="250 / 270" className="rounded-lg" />
          <SkeletonText tone="light" className="h-4 w-4/5" />
          <SkeletonBlock tone="light" className="h-6 w-2/3 rounded" />
        </div>
      ))}
    </div>
  );
}

function ProductRailSectionSkeleton() {
  return (
    <section className="space-y-10">
      <SkeletonText className="h-8 w-48" />
      <ProductCardsSkeleton />
    </section>
  );
}

function NewestSectionSkeleton() {
  return (
    <section aria-hidden="true" className="home-full-bleed overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-[-160px] z-0 overflow-hidden blur-[74.5px]"
      >
        {NEWEST_BACKGROUND_ELLIPSES.map((ellipseClass, index) => (
          <span key={index} className={`absolute rounded-full opacity-[0.45] ${ellipseClass}`} />
        ))}
      </div>

      <div className="relative z-10 mx-auto flex min-h-[360px] w-screen max-w-[1360px] items-center px-2 py-8 sm:px-5 md:min-h-[430px] md:py-10 lg:min-h-[510px] lg:px-[60px] lg:py-0 3xl:max-w-[1440px] 4xl:max-w-[1760px] 4xl:px-20">
        <div className="w-full min-w-0 space-y-10">
          <SkeletonText className="h-8 w-48" />
          <ProductCardsSkeleton />
        </div>
      </div>
    </section>
  );
}

function GifPromoSectionSkeleton() {
  return (
    <section aria-hidden="true" className="w-full min-w-0 overflow-hidden">
      <div className="grid min-w-0 grid-cols-1 gap-2 xl:grid-cols-2">
        {[...Array(2)].map((_, index) => (
          <div
            key={index}
            className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(190px,42vw)_minmax(0,1fr)] lg:grid-cols-[329.5px_1fr]"
          >
            <SkeletonBlock className="min-h-[360px] w-full rounded-[24px] sm:min-h-[480px] lg:h-[564px] lg:min-h-0" />
            <div className="xs:grid-cols-2 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-1 lg:h-full lg:content-between lg:gap-0">
              {[...Array(4)].map((_, productIndex) => (
                <SkeletonBlock
                  key={productIndex}
                  tone="light"
                  className="h-32 rounded-2xl lg:h-[132px]"
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

async function NewestSection({
  getSections,
  batchedSectionsPromise,
}: {
  getSections: HomepageSectionsLoader;
  batchedSectionsPromise: BatchedHomepageSectionsPromise;
}) {
  const batchedSections = await batchedSectionsPromise;
  const batchedProducts = pickBatchedHomepageSection(batchedSections, "newest");
  const newProducts = batchedProducts ?? (await getSections()).new;
  const isEmpty = newProducts.length === 0;

  return (
    <section
      data-home-section="newest-products"
      data-home-full-bleed="newest"
      className="home-full-bleed overflow-hidden"
    >
      <div
        aria-hidden="true"
        data-newest-backdrop
        className="pointer-events-none absolute inset-[-160px] z-0 overflow-hidden blur-[74.5px]"
      >
        {NEWEST_BACKGROUND_ELLIPSES.map((ellipseClass, index) => (
          <span key={index} className={`absolute rounded-full opacity-[0.85] ${ellipseClass}`} />
        ))}
      </div>

      <div
        data-home-contained-content="newest"
        className={`relative z-10 mx-auto flex w-screen max-w-[1360px] items-center px-2 py-8 sm:px-5 md:py-10 lg:px-[60px] 3xl:max-w-[1440px] 4xl:max-w-[1760px] 4xl:px-20 ${
          isEmpty
            ? "min-h-[240px] md:min-h-[280px] lg:min-h-[320px]"
            : "min-h-[360px] md:min-h-[430px] lg:min-h-[510px] lg:py-0"
        }`}
      >
        <div className="w-full min-w-0">
          {/* Single render: OffersListHomePage adapts to mobile (scroll) vs desktop (grid)
              internally, so the previous hidden md:block / md:hidden split hydrated every
              ProductCard twice. */}
          <div className="space-y-10">
            <Reveal variant="fade-up" duration={700}>
              {isEmpty ? (
                <div
                  data-home-empty-state="newest-products"
                  className="mx-auto flex max-w-xl flex-col items-center rounded-[24px] border border-white/70 bg-white/75 px-5 py-7 text-center shadow-sm sm:px-8"
                >
                  <span
                    className="mb-3 inline-flex size-11 items-center justify-center rounded-full bg-infinity-primary-lighter/55 text-infinity-primary"
                    aria-hidden="true"
                  >
                    <NewIcon />
                  </span>
                  <h2 className="font-peyda-fanum text-2xl font-medium text-infinity-primary">
                    جدیدترین ها
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-gray-600">
                    محصولات تازه در حال آماده‌سازی‌اند. مجموعه کامل فروشگاه همچنان در دسترس شماست.
                  </p>
                  <Link
                    href="/plp"
                    className="pressable mt-5 inline-flex min-h-11 items-center justify-center rounded-full bg-infinity-primary px-6 py-2 text-sm font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2"
                  >
                    مشاهده همه محصولات
                  </Link>
                </div>
              ) : (
                <HomeOffersList
                  sectionId="newest"
                  icon={<NewIcon />}
                  title="جدیدترین ها"
                  products={newProducts}
                />
              )}
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}

async function FavoritesSection({
  getSections,
  batchedSectionsPromise,
}: {
  getSections: HomepageSectionsLoader;
  batchedSectionsPromise: BatchedHomepageSectionsPromise;
}) {
  const batchedSections = await batchedSectionsPromise;
  const favorites =
    pickBatchedHomepageSection(batchedSections, "favorites") ?? (await getSections()).favorites;
  if (favorites.length === 0) return null;

  return (
    <section className="space-y-10">
      {/* Single render (see NewestSection) — avoids double ProductCard hydration. */}
      <Reveal variant="fade-up" duration={700}>
        <HomeOffersList
          sectionId="favorites"
          icon={<NewIcon />}
          title="محبوب ترین ها"
          products={favorites}
        />
      </Reveal>
    </section>
  );
}

async function DiscountedSection({
  getSections,
  batchedSectionsPromise,
}: {
  getSections: HomepageSectionsLoader;
  batchedSectionsPromise: BatchedHomepageSectionsPromise;
}) {
  const batchedSections = await batchedSectionsPromise;
  const discounted =
    pickBatchedHomepageSection(batchedSections, "discounted") ?? (await getSections()).discounted;
  if (discounted.length === 0) return null;

  return (
    <section>
      <Reveal variant="fade-up" duration={700}>
        <HomeOffersList
          sectionId="discounted"
          icon={<OffIcon />}
          title="تخفیف‌های وسوسه انگیز"
          products={discounted}
        />
      </Reveal>
    </section>
  );
}

async function GifPromoSection({
  homepageSettings,
  batchedSectionsPromise,
}: {
  homepageSettings: SuperAdminSettings;
  batchedSectionsPromise: BatchedHomepageSectionsPromise;
}) {
  const batchedSections = await batchedSectionsPromise;
  const batchedSlot1 = pickBatchedHomepageSection(batchedSections, "gifPromoSlot1");
  const batchedSlot2 = pickBatchedHomepageSection(batchedSections, "gifPromoSlot2");
  const fallbackProducts =
    batchedSlot1 === null || batchedSlot2 === null
      ? await getGifPromoProducts(homepageSettings)
      : { slot1: [], slot2: [] };
  const gifPromoProducts = {
    slot1: batchedSlot1 ?? fallbackProducts.slot1,
    slot2: batchedSlot2 ?? fallbackProducts.slot2,
  };

  return (
    <Reveal variant="fade-up" duration={700}>
      <HomeGifPromoSection
        slots={[
          {
            id: "slot-1",
            imageUrl: homepageSettings.homeGifPromoSlot1Image,
            products: gifPromoProducts.slot1,
          },
          {
            id: "slot-2",
            imageUrl: homepageSettings.homeGifPromoSlot2Image,
            products: gifPromoProducts.slot2,
          },
        ]}
      />
    </Reveal>
  );
}

async function CustomSection({
  homepageSettings,
  batchedSectionsPromise,
}: {
  homepageSettings: SuperAdminSettings;
  batchedSectionsPromise: BatchedHomepageSectionsPromise;
}) {
  const batchedSections = await batchedSectionsPromise;
  const customSectionProducts =
    pickBatchedHomepageSection(batchedSections, "custom") ??
    (await getHomeSectionProducts(homepageSettings.homeCustomSectionAssignment));
  if (customSectionProducts.length === 0) return null;

  return (
    <section>
      <Reveal variant="fade-up" duration={700}>
        <HomeOffersList
          sectionId="custom"
          icon={<NewIcon />}
          title={homepageSettings.homeCustomSectionTitle || "بخش ویژه"}
          products={customSectionProducts}
          viewAllHref={customSectionViewAllHref(
            homepageSettings.homeCustomSectionAssignment,
            homepageSettings.homeCustomSectionViewAllHref,
          )}
        />
      </Reveal>
    </section>
  );
}

async function CustomSectionTwo({
  homepageSettings,
  batchedSectionsPromise,
}: {
  homepageSettings: SuperAdminSettings;
  batchedSectionsPromise: BatchedHomepageSectionsPromise;
}) {
  const batchedSections = await batchedSectionsPromise;
  const customSectionTwoProducts =
    pickBatchedHomepageSection(batchedSections, "customTwo") ??
    (await getHomeSectionProducts(homepageSettings.homeCustomSectionTwoAssignment));
  if (customSectionTwoProducts.length === 0) return null;

  return (
    <section>
      <Reveal variant="fade-up" duration={700}>
        <HomeOffersList
          sectionId="customTwo"
          icon={<NewIcon />}
          title={homepageSettings.homeCustomSectionTwoTitle || "بخش ویژه"}
          products={customSectionTwoProducts}
          viewAllHref={customSectionViewAllHref(
            homepageSettings.homeCustomSectionTwoAssignment,
            homepageSettings.homeCustomSectionTwoViewAllHref,
          )}
        />
      </Reveal>
    </section>
  );
}

async function CustomSectionThree({
  homepageSettings,
  batchedSectionsPromise,
}: {
  homepageSettings: SuperAdminSettings;
  batchedSectionsPromise: BatchedHomepageSectionsPromise;
}) {
  const batchedSections = await batchedSectionsPromise;
  const customSectionThreeProducts =
    pickBatchedHomepageSection(batchedSections, "customThree") ??
    (await getHomeSectionProducts(homepageSettings.homeCustomSectionThreeAssignment));
  if (customSectionThreeProducts.length === 0) return null;

  return (
    <section>
      <Reveal variant="fade-up" duration={700}>
        <HomeOffersList
          sectionId="customThree"
          icon={<NewIcon />}
          title={homepageSettings.homeCustomSectionThreeTitle || "بخش ویژه"}
          products={customSectionThreeProducts}
          viewAllHref={customSectionViewAllHref(
            homepageSettings.homeCustomSectionThreeAssignment,
            homepageSettings.homeCustomSectionThreeViewAllHref,
          )}
        />
      </Reveal>
    </section>
  );
}

async function WeeklyPicksSection({
  productIds,
  batchedSectionsPromise,
}: {
  productIds: number[];
  batchedSectionsPromise: BatchedHomepageSectionsPromise;
}) {
  const batchedSections = await batchedSectionsPromise;
  const weeklyPicksProducts =
    pickBatchedHomepageSection(batchedSections, "weeklyPicks") ??
    (await getProductsByIds(productIds));
  if (weeklyPicksProducts.length === 0) return null;

  return (
    <section>
      <Reveal variant="fade-up" duration={700}>
        <HomeOffersList
          sectionId="weeklyPicks"
          icon={<NewIcon />}
          title="منتخب‌های این هفته"
          products={weeklyPicksProducts}
        />
      </Reveal>
    </section>
  );
}

async function EveryoneFollowsSection({
  productIds,
  batchedSectionsPromise,
}: {
  productIds: number[];
  batchedSectionsPromise: BatchedHomepageSectionsPromise;
}) {
  const batchedSections = await batchedSectionsPromise;
  const everyoneFollowsProducts =
    pickBatchedHomepageSection(batchedSections, "everyoneFollows") ??
    (await getProductsByIds(productIds));
  if (everyoneFollowsProducts.length === 0) return null;

  return (
    <section>
      <Reveal variant="fade-up" duration={700}>
        <HomeOffersList
          sectionId="everyoneFollows"
          icon={<NewIcon />}
          title="همه دنبالشَن"
          products={everyoneFollowsProducts}
        />
      </Reveal>
    </section>
  );
}

/** Streamed block: product sections keep DOM order but no longer wait on one aggregate Promise.all. */
export default function HomeProductSections({
  homepageSettings,
  promoBanners,
}: {
  homepageSettings?: SuperAdminSettings;
  promoBanners?: HomePromoBanner[];
}) {
  let homepageSectionsPromise: HomepageSectionsPromise | null = null;
  const getHomepageSectionsFallback = () => {
    homepageSectionsPromise ??= getHomepageSections(homepageSettings);
    return homepageSectionsPromise;
  };
  const batchedSectionsPromise = getBatchedHomepageSections();
  const hasPromoBanners = promoBanners?.some((banner) => Boolean(banner.imageUrl?.trim()));

  return (
    <>
      <Suspense fallback={<NewestSectionSkeleton />}>
        <NewestSection
          getSections={getHomepageSectionsFallback}
          batchedSectionsPromise={batchedSectionsPromise}
        />
      </Suspense>

      <Suspense fallback={<ProductRailSectionSkeleton />}>
        <FavoritesSection
          getSections={getHomepageSectionsFallback}
          batchedSectionsPromise={batchedSectionsPromise}
        />
      </Suspense>

      {homepageSettings?.homeCustomSectionTwoEnabled && (
        <Suspense fallback={<ProductRailSectionSkeleton />}>
          <CustomSectionTwo
            homepageSettings={homepageSettings}
            batchedSectionsPromise={batchedSectionsPromise}
          />
        </Suspense>
      )}

      <Suspense fallback={<ProductRailSectionSkeleton />}>
        <DiscountedSection
          getSections={getHomepageSectionsFallback}
          batchedSectionsPromise={batchedSectionsPromise}
        />
      </Suspense>

      {homepageSettings?.homeGifPromoEnabled && (
        <Suspense fallback={<GifPromoSectionSkeleton />}>
          <GifPromoSection
            homepageSettings={homepageSettings}
            batchedSectionsPromise={batchedSectionsPromise}
          />
        </Suspense>
      )}

      {homepageSettings?.homeCustomSectionEnabled && (
        <Suspense fallback={<ProductRailSectionSkeleton />}>
          <CustomSection
            homepageSettings={homepageSettings}
            batchedSectionsPromise={batchedSectionsPromise}
          />
        </Suspense>
      )}

      {hasPromoBanners && (
        <section>
          <Reveal variant="fade-up" duration={700}>
            <HomePromoBanners banners={promoBanners ?? []} />
          </Reveal>
        </section>
      )}

      {homepageSettings?.homeWeeklyPicksEnabled &&
        homepageSettings.homeWeeklyPicksProductIds.length > 0 && (
          <Suspense fallback={<ProductRailSectionSkeleton />}>
            <WeeklyPicksSection
              productIds={homepageSettings.homeWeeklyPicksProductIds}
              batchedSectionsPromise={batchedSectionsPromise}
            />
          </Suspense>
        )}

      {homepageSettings?.homeCustomSectionThreeEnabled && (
        <Suspense fallback={<ProductRailSectionSkeleton />}>
          <CustomSectionThree
            homepageSettings={homepageSettings}
            batchedSectionsPromise={batchedSectionsPromise}
          />
        </Suspense>
      )}

      {homepageSettings?.homeEveryoneFollowsEnabled &&
        homepageSettings.homeEveryoneFollowsProductIds.length > 0 && (
          <Suspense fallback={<ProductRailSectionSkeleton />}>
            <EveryoneFollowsSection
              productIds={homepageSettings.homeEveryoneFollowsProductIds}
              batchedSectionsPromise={batchedSectionsPromise}
            />
          </Suspense>
        )}
    </>
  );
}
