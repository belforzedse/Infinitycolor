/**
 * Centralized site configuration
 * Used across the application to maintain consistency
 */
/**
 * The storefront's public origin.
 *
 * Hardcoded for production builds on purpose. This value is inlined at build time and
 * drives canonical/OG URLs, the `/auth/callback` redirect target, and the same-origin
 * guard in `lib/central-auth-server.ts`. On 2026-09-14 a stale `SITE_URL` in the build
 * environment baked `https://new.infinitycolor.co` into the production image, which sent
 * every completed login to a host that bypasses the CDN and made the storefront 403 its
 * own route-hint writes. A build argument must not be able to move the production origin
 * again, and a wrong value here is invisible in git, in `docker inspect`, and in a source
 * build -- it only shows up in the compiled chunks.
 *
 * The override survives only outside production, because the E2E suite serves the app
 * from `http://localhost:2888` and needs the origin to follow.
 */
const PRODUCTION_SITE_URL = "https://infinitycolor.co";

export const SITE_URL =
  process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT === "production"
    ? PRODUCTION_SITE_URL
    : process.env.NEXT_PUBLIC_SITE_URL || PRODUCTION_SITE_URL;
export const SITE_NAME = "فروشگاه پوشاک اینفینیتی";

