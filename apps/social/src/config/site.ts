/**
 * Central auth validates return targets against this exact origin, so it has
 * to follow the deployment (`http://localhost:2890` in dev) rather than stay
 * pinned to production. main.Dockerfile already passes NEXT_PUBLIC_SITE_URL.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://infinitygram.co";
export const SITE_NAME = "اینفینیتی گرام";

function resolveStorefrontUrl(raw: string | undefined): string {
  const fallback = "https://new.infinitycolor.co";
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    return url.origin !== "null" ? raw : fallback;
  } catch {
    return fallback;
  }
}

/** URL of the Infinity Store storefront. Configurable via NEXT_PUBLIC_STOREFRONT_URL. */
export const STOREFRONT_URL = resolveStorefrontUrl(
  process.env.NEXT_PUBLIC_STOREFRONT_URL,
);
