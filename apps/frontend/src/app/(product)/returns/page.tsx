import type { Metadata } from "next";
import Breadcrumb from "@/components/Kits/Breadcrumb";
import { BreadcrumbSchema } from "@/components/SEO/BreadcrumbSchema";
import PageContainer from "@/components/layout/PageContainer";
import ReturnPolicyArticle from "@/components/Returns/ReturnPolicyArticle";
import { SITE_URL } from "@/config/site";
import { RETURNS_PATH, RETURNS_TITLE } from "@/constants/legal";
import { getSiteIdentity, resolveSiteName } from "@/services/site-identity";

export const prefetch = "force-disabled";

const RETURNS_DESCRIPTION =
  "شرایط تعویض و مرجوع کالا در فروشگاه اینفینیتی؛ نقص سفارش، موارد بهداشتی، محصولات اپسی، کالاهای تخفیف‌دار و هزینه ارسال مجدد.";

const breadcrumbItems = [
  { label: "صفحه اصلی", href: "/" },
  { label: RETURNS_TITLE, href: RETURNS_PATH },
];

export async function generateMetadata(): Promise<Metadata> {
  const identity = await getSiteIdentity();
  const siteName = resolveSiteName(identity.siteName);

  return {
    title: RETURNS_TITLE,
    description: RETURNS_DESCRIPTION,
    alternates: {
      canonical: `${SITE_URL}${RETURNS_PATH}`,
    },
    openGraph: {
      title: `${RETURNS_TITLE} | ${siteName}`,
      description: RETURNS_DESCRIPTION,
      url: `${SITE_URL}${RETURNS_PATH}`,
      siteName,
      type: "website",
    },
  };
}

export default function ReturnsPage() {
  return (
    <>
      <BreadcrumbSchema breadcrumbs={breadcrumbItems} />
      <PageContainer variant="wide" className="space-y-8 pb-16 pt-8">
        <header className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="h-12 w-1 shrink-0 rounded-full bg-infinity-primary" />
            <h1 className="text-foreground-primary text-3xl font-bold lg:text-4xl">
              {RETURNS_TITLE}
            </h1>
          </div>
          <Breadcrumb breadcrumbs={breadcrumbItems} />
        </header>

        <ReturnPolicyArticle />
      </PageContainer>
    </>
  );
}
