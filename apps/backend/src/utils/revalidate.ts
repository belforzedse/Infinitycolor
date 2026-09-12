/**
 * Shared helper to trigger Next.js on-demand revalidation from Strapi lifecycles.
 *
 * Posts to the frontend `/api/revalidate` route (protected by REVALIDATION_SECRET)
 * for every configured frontend URL. Used by site-identity and site-faq lifecycles.
 *
 * Mirrors the existing per-lifecycle revalidation pattern (see
 * api/settings/content-types/settings/lifecycles.ts) but shared so identity/faq
 * lifecycles don't each duplicate it.
 */

type RevalidatePayload = Record<string, unknown> & {
  type?: string;
  path?: string;
  tag?: string;
};

export type FrontendRevalidationSummary = {
  attempted: number;
  successful: number;
  failed: number;
};

/**
 * Translate a revalidation payload into the storefront paths a shared cache has
 * to drop.
 *
 * This lives here, at the single point every lifecycle already calls, rather
 * than in each lifecycle: the alternative is thirteen call sites that each have
 * to remember that a product also appears on the homepage, on `/plp`, on each of
 * its category listings and in the sitemap.
 *
 * Returns null when the event has no shared-cache consequence.
 */
async function edgePathsForPayload(
  payload: RevalidatePayload,
): Promise<{ kind: string; paths: string[]; dedupeKey: string } | null> {
  const {
    buildProductPaths,
    buildCategoryPaths,
    buildBlogPaths,
    buildHomePaths,
    buildSiteWidePaths,
  } = await import("./edgeCache");

  const slug = typeof payload.path === "string" ? payload.path : "";
  const explicitSlug = typeof (payload as any).slug === "string" ? (payload as any).slug : "";

  switch (payload.type) {
    case "product":
      return {
        kind: "product",
        paths: buildProductPaths({ slug }),
        dedupeKey: `product:${slug || "unknown"}`,
      };
    case "category-editorial":
      return {
        kind: "category",
        paths: buildCategoryPaths(explicitSlug),
        dedupeKey: `category:${explicitSlug || "unknown"}`,
      };
    case "blog-post":
    case "blog-listing":
      return {
        kind: "blog",
        paths: buildBlogPaths(slug || explicitSlug),
        dedupeKey: `blog:${slug || explicitSlug || "listing"}`,
      };
    case "home-products": {
      // Stock movement reaches here on every reserve and every decrement, which
      // at checkout volume is far more often than the homepage actually changes.
      // Availability is handled where it is actually known -- stock.ts purges
      // only when a variation crosses in or out of stock -- so these are dropped
      // rather than turned into a purge per add-to-cart.
      const reason = typeof (payload as any).reason === "string" ? (payload as any).reason : "";
      if (/^stock-/.test(reason)) return null;
      return { kind: "home", paths: buildHomePaths(), dedupeKey: "home" };
    }
    case "faq":
      return { kind: "faq", paths: ["/faq", "/"], dedupeKey: "faq" };
    case "site-identity":
    case "site-settings":
    case "hero-slider":
      // Layout-level content appears on every page, so every cached page is stale.
      return { kind: "site", paths: buildSiteWidePaths(), dedupeKey: "site" };
    default:
      return null;
  }
}

/**
 * Best-effort by contract: a publish, a price change or a checkout must not fail
 * because a CDN was slow. The job itself retries; this only has to survive the
 * enqueue.
 */
async function enqueueEdgeInvalidation(payload: RevalidatePayload, logPrefix: string) {
  try {
    const { loadEdgeCacheConfig } = await import("./edgeCache");
    // Nothing is in front of the origin until phase 3 is switched on, and an
    // enqueue per product edit until then is a queue full of jobs that would
    // only report "disabled".
    if (!loadEdgeCacheConfig().enabled) return;

    const event = await edgePathsForPayload(payload);
    if (!event) return;

    const { enqueueEdgeCachePurge } = await import("../queue/edge-cache");
    await enqueueEdgeCachePurge(
      {
        kind: event.kind,
        paths: event.paths,
        reason: typeof (payload as any).reason === "string" ? (payload as any).reason : undefined,
      },
      { dedupeKey: event.dedupeKey },
    );
  } catch (error) {
    strapi.log.warn(`[${logPrefix}] Could not enqueue edge invalidation`, error as any);
  }
}

/**
 * Frontend origins to notify, from configuration only.
 *
 * This used to append `https://staging.infinitycolor.co` and
 * `https://infinitycolor.co` unconditionally, so production Strapi POSTed an
 * authenticated revalidation to staging on every write and staging POSTed to
 * production. Each environment must only ever invalidate its own storefront.
 *
 * `NEXTJS_REVALIDATION_URL` accepts a comma-separated list for deployments that
 * genuinely front more than one storefront origin.
 */
export function getFrontendUrls(): string[] {
  const configured = process.env.NEXTJS_REVALIDATION_URL || process.env.FRONTEND_URL || "";

  return configured
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

export async function triggerFrontendRevalidation(
  payload: RevalidatePayload,
  logPrefix = "Revalidation",
): Promise<FrontendRevalidationSummary> {
  const revalidationSecret = process.env.REVALIDATION_SECRET;
  if (!revalidationSecret) {
    strapi.log.error(`[${logPrefix}] REVALIDATION_SECRET environment variable is required`);
    return { attempted: 0, successful: 0, failed: 1 };
  }

  const frontendUrls = getFrontendUrls();
  if (frontendUrls.length === 0) {
    strapi.log.warn(
      `[${logPrefix}] No storefront origin configured (set NEXTJS_REVALIDATION_URL); skipping revalidation`,
    );
    return { attempted: 0, successful: 0, failed: 1 };
  }

  const revalidationPromises = frontendUrls.map(async (frontendUrl) => {
    try {
      const url = `${frontendUrl.replace(/\/$/, "")}/api/revalidate`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${revalidationSecret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        strapi.log.error(
          `[${logPrefix}] Revalidation failed for ${frontendUrl}: ${response.status} ${errorText}`,
        );
        return { url: frontendUrl, success: false };
      }

      strapi.log.info(`[${logPrefix}] Revalidated ${frontendUrl} (${JSON.stringify(payload)})`);
      return { url: frontendUrl, success: true };
    } catch (error: any) {
      if (error?.name === "AbortError") {
        strapi.log.warn(`[${logPrefix}] Revalidation timeout for ${frontendUrl}`);
      } else {
        strapi.log.error(
          `[${logPrefix}] Error triggering revalidation for ${frontendUrl}:`,
          error,
        );
      }
      return { url: frontendUrl, success: false };
    }
  });

  const settled = await Promise.allSettled(revalidationPromises);
  const values = settled.map((entry) =>
    entry.status === "fulfilled" ? entry.value : { success: false },
  );

  // After Next's own cache, not before: the edge refills from the origin, so
  // purging it while Next still holds the old render just reinstates the stale
  // page one layer out.
  //
  // Not awaited. `product-publication.ts` turns this function's summary into
  // `STOREFRONT_REVALIDATION_FAILED` and blocks the publication effect, so an
  // unreachable queue-redis would stall a publish on a cache concern. The
  // enqueue catches its own failures and the job carries its own retries.
  void enqueueEdgeInvalidation(payload, logPrefix);

  return {
    attempted: frontendUrls.length,
    successful: values.filter((value) => value?.success === true).length,
    failed: values.filter((value) => value?.success !== true).length,
  };
}
