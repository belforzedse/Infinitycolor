import { apiClient } from "@/services";
import type { SiteFaq, SiteFaqCategory, SiteFaqItem } from "@/types/site-identity";

const POPULATE = "populate[categories][populate]=items";

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    if (
      "response" in error &&
      error.response &&
      typeof error.response === "object" &&
      "status" in error.response
    ) {
      return (error.response as { status: number }).status;
    }
    if ("status" in error) return (error as { status: number }).status;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Admin normalizer: keeps inactive items and original ordering for editing. */
function normalizeForAdmin(attributes: unknown): SiteFaq {
  const source = asRecord(attributes);
  if (!source || !Array.isArray(source.categories)) return { categories: [] };
  const categories: SiteFaqCategory[] = source.categories.map((raw) => {
    const category = asRecord(raw) ?? {};
    const items = Array.isArray(category.items)
      ? category.items.map((rawItem): SiteFaqItem => {
          const item = asRecord(rawItem) ?? {};
          return {
            question: typeof item.question === "string" ? item.question : "",
            answer: typeof item.answer === "string" ? item.answer : "",
            order: typeof item.order === "number" ? item.order : 0,
            isActive: item.isActive !== false,
          };
        })
      : [];
    return {
      title: typeof category.title === "string" ? category.title : "",
      description: typeof category.description === "string" ? category.description : undefined,
      order: typeof category.order === "number" ? category.order : 0,
      items,
    };
  });
  return { categories };
}

export async function getSuperAdminSiteFaq(): Promise<SiteFaq> {
  try {
    const res = await apiClient.get(`/site-faq?${POPULATE}`, { cache: "no-store" });
    const payload = asRecord((res as { data?: unknown })?.data);
    const attributes =
      payload && "attributes" in payload && payload.attributes ? payload.attributes : payload;
    return attributes ? normalizeForAdmin(attributes) : { categories: [] };
  } catch (error: unknown) {
    if (statusOf(error) === 404) return { categories: [] };
    throw error;
  }
}
