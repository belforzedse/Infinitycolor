import type { Metadata } from "next";
import Image from "next/image";
import Breadcrumb from "@/components/Kits/Breadcrumb";
import { BreadcrumbSchema } from "@/components/SEO/BreadcrumbSchema";
import PageContainer from "@/components/layout/PageContainer";
import Reveal from "@/components/Reveal";
import AboutSection from "@/components/About/AboutSection";
import AboutBanners from "@/components/About/AboutBanners";
import WhyChooseSection from "@/components/About/WhyChooseSection";
import TrustSection from "@/components/About/TrustSection";
import CategoryCarousel from "@/components/Categories/CategoryCarousel";
import { SITE_URL } from "@/config/site";
import { STOREFRONT_MAIN_CATEGORY_OPTIONS } from "@/constants/categories";
import { getProductCategoriesForRender } from "@/services/product/categories";
import { getSiteIdentity, resolveSiteName } from "@/services/site-identity";
import { storeMapLinks } from "@/utils/identityIcons";

// Homepage links may warm the shared product layout, but never this page body.
export const prefetch = "force-disabled";

const ABOUT_DESCRIPTION =
  "اینفینیتی یک فروشگاه آنلاین پیشرو در زمینه پوشاک است که با هدف ارائه تجربه خرید آنلاین منحصر به فرد و لذت‌بخش، بر تنوع، کیفیت و قیمت‌های رقابتی برای پوشاک مردانه، زنانه و کودکان تمرکز دارد.";

export async function generateMetadata(): Promise<Metadata> {
  const identity = await getSiteIdentity();
  const siteName = resolveSiteName(identity.siteName);
  const description = identity.brandDescription?.trim() || ABOUT_DESCRIPTION;

  return {
    title: "درباره ما",
    description,
    alternates: {
      canonical: `${SITE_URL}/about`,
    },
    openGraph: {
      title: `درباره ما | ${siteName}`,
      description,
      url: `${SITE_URL}/about`,
      type: "website",
    },
  };
}

const breadcrumbItems = [
  { label: "صفحه اصلی", href: "/" },
  { label: "درباره ما", href: "/about" },
];

export default async function AboutPage() {
  const [categories, identity] = await Promise.all([
    getProductCategoriesForRender({
      ...STOREFRONT_MAIN_CATEGORY_OPTIONS,
      revalidate: 90,
    }),
    getSiteIdentity(),
  ]);

  const aboutStores = identity.hasPhysicalStores
    ? identity.stores.filter((store) => store.showInAbout)
    : [];

  return (
    <>
      <BreadcrumbSchema breadcrumbs={breadcrumbItems} />
      <PageContainer variant="wide" className="space-y-12 pb-16 pt-8">
        <Reveal variant="fade-up" duration={700}>
          <Breadcrumb breadcrumbs={breadcrumbItems} />
        </Reveal>

        <Reveal variant="fade-up" duration={700} delay={100}>
          <AboutSection title="اینفینیتی" titleAs="h1">
            <p>
              اینفینیتی یک فروشگاه آنلاین پیشرو در زمینه پوشاک است که با هدف ارائه تجربه خرید آنلاین
              منحصر به فرد و لذت‌بخش، بر تنوع، کیفیت و قیمت‌های رقابتی برای پوشاک مردانه، زنانه و
              کودکان تمرکز دارد.
            </p>
          </AboutSection>
        </Reveal>

        <Reveal variant="fade-up" duration={700} delay={200}>
          <div className="space-y-6">
            <AboutSection title="تنوع محصولات">
              <p>
                ما معتقدیم که خرید لباس باید سریع، راحت و لذت‌بخش باشد. ماموریت ما این است که مشتریان
                بتوانند با چند کلیک ساده به آخرین استایل‌های جهانی دسترسی پیدا کنند و از تنوع بی‌نظیر
                محصولات، محصولاتی را انتخاب کنند که با سلیقه و نیازهایشان هماهنگ باشد.
              </p>
            </AboutSection>
            {categories.length > 0 && <CategoryCarousel categories={categories} />}
          </div>
        </Reveal>

        <Reveal variant="fade-up" duration={700} delay={300}>
          <WhyChooseSection
            title="چرا اینفینیتی رو انتخاب کنیم؟"
            items={[
              "تنوع بی نظیر محصولات از تی شرتهای راحتی تا کت و شلوارهای رسمی ما برای هر سبک و سلیقه ای گزینه ای داریم",
              "قیمت های شگفت انگیز بهترین کیفیت را با قیمتی که شایسته شماست ارائه میدهیم.",
              "ارسال سریع و مطمئن تیم ما تلاش میکند سفارشهای شما را در کوتاه ترین زمان ممکن به دستتان برساند.",
              "پشتیبانی حرفه ای هر زمان که نیاز به کمک داشتید تیم پشتیبانی ما آماده پاسخگویی به شماست.",
            ]}
          />
        </Reveal>

        <Reveal variant="fade-up" duration={700} delay={400}>
          <div className="space-y-6">
            <AboutSection title="قیمت هامون؟ به صرفه ترین">
              <p>
                ما متعهد به ارائه محصولات با کیفیت با قیمت‌های منصفانه هستیم و اطمینان می‌دهیم که
                همه بتوانند بدون نگرانی از هزینه‌ها، استایل مورد نظر خود را خلق کنند. ما تخفیف‌ها و
                پیشنهادهای جذابی داریم و تیم ما پرانرژی و پرشور است و همه چیز را از انتخاب محصول تا
                بسته‌بندی و ارسال با دقت و عشق انجام می‌دهد. مشتریان ما فقط خریدار نیستند، بلکه بخشی
                از خانواده اینفینیتی هستند.
              </p>
            </AboutSection>
            <AboutBanners />
          </div>
        </Reveal>

        <Reveal variant="fade-up" duration={700} delay={500}>
          <TrustSection title="به ما اعتماد کنین">
            <p>
              ما به شما اعتماد داریم که خرید آنلاین با اینفینیتی را تجربه کنید. ما بر کیفیت، قیمت و
              خدمات تمرکز داریم و فقط محصولاتی را توصیه می‌کنیم که خودمان استفاده می‌کنیم. ما
              اطمینان می‌دهیم که آنچه در عکس‌ها می‌بینید دقیقاً همان چیزی است که دریافت می‌کنید.
            </p>
            <p>
              ما متعهد به پاسخ سریع به سوالات، حل مشکلات و ارائه پشتیبانی هستیم. ما همچنین متعهد به
              ارسال سریع، ایمن و مرتب هستیم. ما به کار خود علاقه‌مند هستیم و هدف ما این است که هر
              بار که خرید می‌کنید، احساس خوب و امنیت داشته باشید و بدانید که همیشه به فکر شما هستیم.
            </p>
          </TrustSection>
        </Reveal>

        {aboutStores.length > 0 && (
          <Reveal variant="fade-up" duration={700} delay={600}>
            <AboutSection title="فروشگاه‌های حضوری">
              <div className="grid gap-4 md:grid-cols-2">
                {aboutStores.map((store, index) => {
                  const mapLinks = storeMapLinks(store);
                  return (
                    <div
                      key={index}
                      className="space-y-3 rounded-2xl border border-slate-100 bg-white p-5"
                    >
                      {store.name && (
                        <p className="text-foreground-primary text-lg font-bold">{store.name}</p>
                      )}
                      {store.address && (
                        <p className="text-sm leading-7 text-neutral-600">{store.address}</p>
                      )}
                      {store.phones.length > 0 && (
                        <div className="flex flex-col gap-1">
                          {store.phones.map((phone, phoneIndex) => (
                            <span key={phoneIndex} className="text-sm text-neutral-600" dir="ltr">
                              {phone.label ? `${phone.label}: ${phone.number}` : phone.number}
                            </span>
                          ))}
                        </div>
                      )}
                      {mapLinks.length > 0 && (
                        <div className="flex gap-2">
                          {mapLinks.map((icon) => (
                            <a
                              key={icon.src}
                              href={icon.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="transition-transform hover:scale-110"
                              aria-label={icon.alt}
                            >
                              <Image
                                src={icon.src}
                                alt={icon.alt}
                                width={28}
                                height={28}
                                className="rounded-full"
                                loading="lazy"
                                sizes="28px"
                              />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </AboutSection>
          </Reveal>
        )}
      </PageContainer>
    </>
  );
}
