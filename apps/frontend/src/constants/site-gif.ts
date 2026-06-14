/** Recommended desktop dimensions for the site GIF banner (px). */
export const SITE_GIF_DESKTOP_WIDTH = 1320;
export const SITE_GIF_DESKTOP_HEIGHT = 55;

/** Tailwind arbitrary aspect ratio class for the site GIF rail. */
export const SITE_GIF_ASPECT_CLASS = "aspect-[1320/55]";

const STRAPI_RESPONSIVE_GIF_PATH_RE =
  /(^|\/)uploads\/(?:large|medium|small|thumbnail)_([^/?#]+\.gif)(?=$|[?#])/i;

export function normalizeSiteGifImageUrl(imageUrl?: string | null): string {
  const trimmed = imageUrl?.trim() ?? "";
  if (!trimmed) return "";

  return trimmed.replace(
    STRAPI_RESPONSIVE_GIF_PATH_RE,
    (_match, prefix: string, filename: string) => `${prefix}uploads/${filename}`,
  );
}
