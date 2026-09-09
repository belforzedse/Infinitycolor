import type { BlogComment } from "@/services/blog/blog.service";
import { isRecord, readOptionalText, unwrapStrapiFields } from "./strapiEntity";

const PLACEHOLDER_NAMES = new Set(["کاربر ناشناس", "undefined undefined"]);

function extractUserInfo(user?: BlogComment["user"]) {
  const candidate = user?.user_info;
  if (!candidate) {
    return null;
  }

  const fields = unwrapStrapiFields(candidate);
  if (fields) {
    return fields;
  }

  return isRecord(candidate) ? candidate : null;
}

function isUsableDisplayName(value?: string): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return !PLACEHOLDER_NAMES.has(trimmed);
}

export function resolveBlogCommentUserDisplayName(
  user?: BlogComment["user"],
  fallbackName?: string,
): string {
  const normalizedInfo = extractUserInfo(user);
  const firstName =
    readOptionalText(normalizedInfo?.FirstName) ||
    readOptionalText(normalizedInfo?.first_name) ||
    "";
  const lastName =
    readOptionalText(normalizedInfo?.LastName) ||
    readOptionalText(normalizedInfo?.last_name) ||
    "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  if (fullName) {
    return fullName;
  }

  if (isUsableDisplayName(fallbackName)) {
    return fallbackName!.trim();
  }

  if (!user) return "کاربر ناشناس";

  const phone = readOptionalText(user.phone) || readOptionalText(user.username);
  if (phone) {
    return phone;
  }

  const email = readOptionalText(user.email);
  if (email) {
    return email;
  }

  return "کاربر ناشناس";
}
