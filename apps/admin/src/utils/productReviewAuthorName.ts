import type { ProductReview } from "@/services/product/product-review.service";
import { isRecord, readOptionalText, unwrapStrapiFields } from "./strapiEntity";

function extractUserInfo(user?: ProductReview["user"]) {
  const candidate = user?.user_info;
  if (!candidate) {
    return null;
  }

  const fields = unwrapStrapiFields(candidate) ?? (isRecord(candidate) ? candidate : null);
  if (!fields) {
    return null;
  }

  return {
    FirstName: readOptionalText(fields.FirstName),
    LastName: readOptionalText(fields.LastName),
  };
}

export function resolveProductReviewUserDisplayName(
  user?: ProductReview["user"],
  fallbackPhone?: string,
): string {
  const normalizedInfo = extractUserInfo(user);
  const firstName = normalizedInfo?.FirstName || "";
  const lastName = normalizedInfo?.LastName || "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  if (fullName) {
    return fullName;
  }

  const phone =
    readOptionalText(user?.Phone) ||
    readOptionalText(user?.phone) ||
    readOptionalText(fallbackPhone);
  if (phone) {
    return phone;
  }

  const username = readOptionalText(user?.username);
  if (username) {
    return username;
  }

  return "کاربر ناشناس";
}
