import type { ApiError } from "@repo/api/types";
import { apiClient } from "@/lib/api-client";

export type EditorialStatus = "active" | "draft" | "none";

export type CategoryEditorialTarget = {
  id: number;
  title: string;
  slug: string;
  status: EditorialStatus;
  updatedAt: string | null;
};

export type EditableCategoryEditorial = {
  category: { id: number; title: string; slug: string };
  editorial: null | {
    id: number;
    title: string;
    paragraph: string;
    content: string;
    isPublished: boolean;
    isRtl: boolean;
    audio: null | {
      id: number;
      url: string;
      name: string;
      mime: string;
    };
    updatedAt: string | null;
  };
};

export type CategoryEditorialDraft = {
  title: string;
  paragraph: string;
  content: string;
  isPublished: boolean;
  isRtl: boolean;
};

export async function listCategoryEditorialTargets(params: {
  page?: number;
  pageSize?: number;
  q?: string;
}) {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 50),
  });
  if (params.q?.trim()) query.set("q", params.q.trim());
  return apiClient.get<CategoryEditorialTarget[]>(
    `/category-editorial/targets?${query}`,
  );
}

export async function getCategoryEditorial(categoryId: number) {
  const response = await apiClient.get<EditableCategoryEditorial>(
    `/category-editorial/${categoryId}`,
    { cache: "no-store" },
  );
  return response.data;
}

export async function saveCategoryEditorial(
  categoryId: number,
  draft: CategoryEditorialDraft,
  expectedUpdatedAt: string | null,
) {
  return apiClient.put<EditableCategoryEditorial>(
    `/category-editorial/${categoryId}`,
    {
      data: {
        Title: draft.title,
        Paragraph: draft.paragraph,
        Content: draft.content,
        IsPublished: draft.isPublished,
        IsRTL: draft.isRtl,
      },
      expectedUpdatedAt,
    },
  ) as Promise<{
    data: EditableCategoryEditorial;
    meta?: { revalidationFailed?: boolean };
  }>;
}

export function categoryEditorialErrorMessage(error: unknown): string {
  const apiError = error as ApiError;
  if (apiError?.status === 409)
    return "این محتوا هم‌زمان تغییر کرده است. نسخه تازه را دریافت کنید.";
  if (apiError?.errorCode === "EDITORIAL_IMAGE_ALT_REQUIRED") {
    return "برای همه تصاویر متن جایگزین بنویسید.";
  }
  return "دریافت یا ذخیره محتوا انجام نشد. دوباره تلاش کنید.";
}
