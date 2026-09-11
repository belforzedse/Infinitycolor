import { isUserInfo } from "@/services/product/product-review.service";
import type { ProductReview } from "@/services/product/product-review.service";

function extractUserInfo(user?: ProductReview["user"]) {
  const candidate = user?.user_info;
  if (!candidate) {
    return null;
  }
  return isUserInfo(candidate) ? candidate : null;
}

export function resolveProductReviewUserDisplayName(
  user?: ProductReview["user"],
  fallbackPhone?: string
): string {
  if (!user) return fallbackPhone || "کاربر ناشناس";

  const normalizedInfo = extractUserInfo(user);
  const firstName = normalizedInfo?.FirstName?.trim() || "";
  const lastName = normalizedInfo?.LastName?.trim() || "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  if (fullName) {
    return fullName;
  }

  const phone = (user.Phone || user.phone)?.trim();
  if (phone) {
    // Format phone number to mask middle digits for privacy
    if (phone.length > 7) {
      return `${phone.slice(0, 4)}***${phone.slice(-4)}`;
    }
    return phone;
  }

  const username = user.username?.trim();
  if (username) {
    return username;
  }

  return fallbackPhone || "کاربر ناشناس";
}

/**
 * Preferred author name for a rendered review or reply.
 *
 * The API resolves the name server side (`authorDisplayName`) because public
 * responses never carry the `user` relation. The relation-based resolver stays
 * as the fallback for privileged callers and for responses served by a backend
 * that predates the field.
 */
export function resolveProductReviewDisplayName(review?: {
  authorDisplayName?: string;
  user?: ProductReview["user"];
}): string {
  const provided = review?.authorDisplayName?.trim();
  if (provided) {
    return provided;
  }
  return resolveProductReviewUserDisplayName(review?.user, review?.user?.Phone);
}
