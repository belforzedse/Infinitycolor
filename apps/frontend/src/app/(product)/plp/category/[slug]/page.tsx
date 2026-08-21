import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import PLPPageView from "../../PLPPageView";
import PLPLoading from "../../loading";
import {
  buildInvalidPLPMetadata,
  buildPLPMetadata,
  getPLPCategoryContext,
  parsePLPQuery,
} from "@/services/product/plp";

// Category data is URL-specific and must never be prefetched from the homepage.
export const prefetch = "force-disabled";

interface CategoryPLPPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

async function CategoryPLPContent({ params, searchParams }: CategoryPLPPageProps) {
  const { slug } = await params;
  return <PLPPageView categorySlug={slug} searchParams={searchParams} />;
}

export default function CategoryPLPPage(props: CategoryPLPPageProps) {
  return (
    <Suspense fallback={<PLPLoading />}>
      <CategoryPLPContent {...props} />
    </Suspense>
  );
}

export async function generateMetadata({
  params,
  searchParams,
}: CategoryPLPPageProps): Promise<Metadata> {
  const [{ slug }, resolvedSearchParams] = await Promise.all([params, searchParams]);
  const query = parsePLPQuery(resolvedSearchParams);
  const category = await getPLPCategoryContext(slug);

  if (!category) {
    notFound();
    return buildInvalidPLPMetadata();
  }

  return buildPLPMetadata(query, category);
}
