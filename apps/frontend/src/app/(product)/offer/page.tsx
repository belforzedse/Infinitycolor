import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import PLPPageView from "../plp/PLPPageView";
import PLPLoading from "../plp/loading";
import { buildInvalidPLPMetadata, buildOfferPLPMetadata } from "@/services/product/plp";
import { parsePLPOffer } from "@/utils/plpRoutes";

// Listings and their data load after activation; only the parent shell may warm.
export const prefetch = "force-disabled";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

interface OfferPageProps {
  searchParams: SearchParams;
}

async function OfferPLPContent({ searchParams }: OfferPageProps) {
  const offer = parsePLPOffer((await searchParams).type);
  if (!offer) notFound();
  return <PLPPageView offer={offer} searchParams={searchParams} />;
}

/**
 * A server-ranked listing (`/offer?type=newest`) on the normal PLP: same grid, cards,
 * filters and pagination, while the backend owns the dataset and its default order.
 * No segment loading.tsx, so an unknown `type` still resolves to a real 404 in
 * generateMetadata before anything streams (see soft-404-architecture.test.ts).
 */
export default function OfferPLPPage(props: OfferPageProps) {
  return (
    <Suspense fallback={<PLPLoading />}>
      <OfferPLPContent {...props} />
    </Suspense>
  );
}

export async function generateMetadata({ searchParams }: OfferPageProps): Promise<Metadata> {
  const offer = parsePLPOffer((await searchParams).type);
  if (!offer) {
    notFound();
    return buildInvalidPLPMetadata();
  }
  return buildOfferPLPMetadata(offer);
}
