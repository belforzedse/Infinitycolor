/**
 * Centralized site configuration
 * Used across the application to maintain consistency
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_ADMIN_URL || process.env.ADMIN_URL || "http://localhost:2891";
export const SITE_NAME = "مدیریت اینفینیتی";
