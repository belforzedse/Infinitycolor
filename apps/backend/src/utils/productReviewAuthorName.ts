/**
 * Public display name for a product review / review reply author.
 *
 * Storefront review listings are served to anonymous and customer callers, and
 * Strapi's `removeRestrictedRelations` strips the `user` relation from their
 * responses (neither role holds `plugin::users-permissions.user.find`). The
 * controller therefore resolves the author name server side and returns only
 * this string — never the user entity, which carries email, role and the
 * credential columns.
 *
 * The resolution order and the phone masking mirror the storefront's
 * `apps/frontend/src/utils/productReviewAuthorName.ts` so a review renders the
 * same name whether it was named by the API or by the legacy client fallback.
 */

const ANONYMOUS_AUTHOR = "کاربر ناشناس";

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractUserInfo(user: any) {
  const candidate = user?.user_info;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate.data?.attributes || candidate.attributes || candidate;
}

/** Masks the middle of a phone number so a nameless author is not published verbatim. */
function maskPhone(phone: string): string {
  return phone.length > 7 ? `${phone.slice(0, 4)}***${phone.slice(-4)}` : phone;
}

export function resolveProductReviewAuthorName(user: any): string {
  if (!user || typeof user !== "object") return ANONYMOUS_AUTHOR;

  const info = extractUserInfo(user);
  const fullName = [readText(info?.FirstName), readText(info?.LastName)]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (fullName) return fullName;

  const phone = readText(user.Phone) || readText(user.phone) || readText(info?.Phone);
  if (phone) return maskPhone(phone);

  const username = readText(user.username);
  if (username) return username;

  return ANONYMOUS_AUTHOR;
}

export { ANONYMOUS_AUTHOR };
