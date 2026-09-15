/**
 * «مشاهده همه» link sanitizer for the homepage custom editorial sections.
 *
 * The stored value ends up as a storefront `<Link href>`, so only same-origin
 * paths are accepted: a scheme, a protocol-relative `//host`, or any control
 * character would turn an admin field into an off-site redirect.
 */

const MAX_HREF_LENGTH = 2048;

const hasUnsafePathChar = (value: string): boolean =>
  /[\s\\]/.test(value) || [...value].some((ch) => ch.charCodeAt(0) < 0x20);

/**
 * Returns the sanitized path, `""` for an intentionally empty link, or `null`
 * when the value must be rejected by the caller.
 */
export function sanitizeCustomSectionHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const href = value.trim();
  if (!href) return "";
  if (href.length > MAX_HREF_LENGTH) return null;
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  if (hasUnsafePathChar(href)) return null;
  return href;
}
