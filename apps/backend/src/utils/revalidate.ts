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
  return {
    attempted: frontendUrls.length,
    successful: values.filter((value) => value?.success === true).length,
    failed: values.filter((value) => value?.success !== true).length,
  };
}
