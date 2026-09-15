import Hero from "@/components/PDP/Hero";
import PageContainer from "@/components/layout/PageContainer";
import type { Metadata } from "next";
import { ENDPOINTS, getStrapiServerUrl } from "@/constants/api";
import { fetchWithTimeout } from "@repo/api";
import { normalizeProductDetail } from "../../normalizeProductDetail";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "پیش‌نمایش محصول",
  robots: { index: false, follow: false },
};

const PREVIEW_FETCH_TIMEOUT_MS = 10000;

async function fetchPreviewDraft(token: string) {
  const strapiBaseUrl = getStrapiServerUrl();
  const apiUrl = `${strapiBaseUrl}${ENDPOINTS.PRODUCT.PRODUCT}/preview-draft/${encodeURIComponent(token)}`;

  try {
    // Ephemeral, single-token data — deliberately uncached (no `next.revalidate`,
    // no `"use cache"`), unlike every other PDP fetch on this route group.
    const response = await fetchWithTimeout(apiUrl, {
      method: "GET",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeoutMs: PREVIEW_FETCH_TIMEOUT_MS,
      cache: "no-store",
    });

    if (!response.ok) return null;

    const data = await response.json();
    return normalizeProductDetail(data?.data);
  } catch {
    return null;
  }
}

export default async function PreviewPDP({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const productData = await fetchPreviewDraft(token);

  if (!productData) {
    return (
      <PageContainer variant="wide" className="flex flex-col items-center gap-3 py-24 text-center">
        <p className="text-lg font-medium text-neutral-700">این پیش‌نمایش منقضی شده است</p>
        <p className="text-sm text-neutral-500">
          لینک پیش‌نمایش پس از ۳۰ دقیقه غیرفعال می‌شود. از پنل ادمین دوباره پیش‌نمایش بگیرید.
        </p>
      </PageContainer>
    );
  }

  const productId = productData.id?.toString() || "";
  const status = productData.attributes?.Status;

  return (
    <PageContainer variant="wide" className="flex flex-col gap-10 pb-16 pt-6">
      <div className="sticky top-0 z-40 flex items-center justify-center gap-2 rounded-xl bg-amber-100 px-4 py-2 text-sm font-medium text-amber-900">
        پیش‌نمایش — تغییرات ذخیره‌نشده{status && status !== "Active" ? ` · وضعیت: ${status}` : ""}
      </div>

      <div className="flex flex-col gap-3">
        <Hero productData={productData} productId={productId} />
      </div>
    </PageContainer>
  );
}
