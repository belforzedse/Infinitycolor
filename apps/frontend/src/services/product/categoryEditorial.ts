import { getStrapiServerUrl } from "@/constants/api";
import { categorySlugTag } from "@/constants/cacheTags";
import fetchWithTimeout from "@/utils/fetchWithTimeout";
import logger from "@/utils/logger";
import type { PLPQuery } from "./plp";

export type CategoryEditorialContent = {
  id: number;
  title: string;
  paragraph: string | null;
  content: string | null;
  audio: null | {
    url: string;
    name: string;
    mime: string;
  };
  seoDescription: string | null;
  isRtl: boolean;
  updatedAt: string | null;
};

export function isCanonicalCategoryEditorialView(query: PLPQuery) {
  return (
    query.page === 1 &&
    !query.category &&
    !query.available &&
    !query.minPrice &&
    !query.maxPrice &&
    !query.size?.length &&
    !query.color?.length &&
    !query.material &&
    !query.season &&
    !query.gender &&
    !query.usage &&
    !query.search &&
    !query.sort &&
    !query.hasDiscount
  );
}

export async function getPublishedCategoryEditorial(
  slug: string,
): Promise<CategoryEditorialContent | null> {
  const baseUrl = getStrapiServerUrl().replace(/\/$/, "");
  const url = `${baseUrl}/category-editorial/public/${encodeURIComponent(slug)}`;
  try {
    const response = await fetchWithTimeout(url, {
      timeoutMs: 10_000,
      next: { revalidate: 3600, tags: [categorySlugTag(slug)] },
    });
    if (!response.ok) {
      logger.warn("[CategoryEditorial] Public content request failed", {
        status: response.status,
        slug,
      });
      return null;
    }
    const payload = (await response.json()) as { data?: CategoryEditorialContent | null };
    return payload.data ?? null;
  } catch (error) {
    logger.warn("[CategoryEditorial] Public content unavailable", {
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
