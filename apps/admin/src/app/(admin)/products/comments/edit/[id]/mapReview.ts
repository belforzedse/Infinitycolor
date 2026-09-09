import type { Comment } from "./config";
import { readOptionalText, unwrapStrapiEntity, unwrapStrapiFields } from "@/utils/strapiEntity";

function readProfileName(user: Record<string, unknown> | undefined): string | undefined {
  if (!user) return undefined;
  const info = unwrapStrapiFields(user.user_info);
  const firstName = readOptionalText(info?.FirstName);
  const lastName = readOptionalText(info?.LastName);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return fullName || undefined;
}

export function mapProductReviewToCommentForm(payload: unknown): Comment | undefined {
  const entity = unwrapStrapiEntity(payload);
  if (!entity) {
    return undefined;
  }

  const user = unwrapStrapiEntity(entity.user);
  const phone =
    readOptionalText(user?.phone) ||
    readOptionalText(user?.Phone) ||
    readOptionalText(user?.username);
  const name = readProfileName(user) || phone || "کاربر ناشناس";

  return {
    id: String(entity.id),
    message: readOptionalText(entity.Content) || "",
    name,
    createdAt: new Date(String(entity.createdAt || Date.now())),
    status: readOptionalText(entity.Status) || "Need for Review",
    username: phone || "",
    updatedAt: new Date(String(entity.updatedAt || Date.now())),
  };
}
