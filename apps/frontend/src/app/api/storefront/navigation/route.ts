import { cacheLife, cacheTag } from "next/cache";
import {
  getNavbarProductCategories,
  getProductCategories,
  type NavigationCategorySource,
} from "@/services/product/categories";

const NAVBAR_RESPONSE_CACHE_CONTROL =
  "public, max-age=300, s-maxage=300, stale-while-revalidate=3300";

export async function getCachedNavigationCategories(
  source: NavigationCategorySource,
  includeChildren: boolean,
) {
  "use cache: remote";
  cacheLife("storefrontPublic");
  cacheTag("navigation", "product-categories");

  if (source === "catalog") {
    return getProductCategories({ parentOnly: true, includeChildren });
  }

  return getNavbarProductCategories({ includeChildren });
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const includeChildren = searchParams.get("includeChildren") === "1";
  const source: NavigationCategorySource =
    searchParams.get("source") === "catalog" ? "catalog" : "assigned";

  try {
    const categories = await getCachedNavigationCategories(source, includeChildren);
    return Response.json(categories, {
      headers: {
        "Cache-Control": NAVBAR_RESPONSE_CACHE_CONTROL,
      },
    });
  } catch {
    // A timeout/error is never an empty navigation result and must never enter an
    // HTTP cache. The client hook keeps its last known-good value and can retry.
    return Response.json(
      { error: "Navigation categories are temporarily unavailable" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
