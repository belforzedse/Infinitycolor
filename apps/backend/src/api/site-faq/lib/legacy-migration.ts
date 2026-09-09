export type LegacyFaqQuestion = {
  Question?: string;
  Answer?: string;
  Order?: number | null;
  IsActive?: boolean | null;
};

export type LegacyFaqCategory = {
  Title?: string;
  Description?: string | null;
  Order?: number | null;
  faq_questions?: LegacyFaqQuestion[];
};

export type SiteFaqItemPayload = {
  question: string;
  answer: string;
  order: number;
  isActive: boolean;
};

export type SiteFaqCategoryPayload = {
  title: string;
  description?: string;
  order: number;
  items: SiteFaqItemPayload[];
};

export function mapLegacyFaqCategories(
  legacy: LegacyFaqCategory[] | null | undefined,
): SiteFaqCategoryPayload[] {
  return (legacy || [])
    .filter((category) => Boolean(category?.Title?.trim()))
    .sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0))
    .map((category, categoryIndex) => ({
      title: (category.Title || "").trim(),
      description: category.Description?.trim() || undefined,
      order: category.Order ?? categoryIndex,
      items: (category.faq_questions || [])
        .filter((question) => Boolean(question?.Question?.trim() && question?.Answer))
        .sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0))
        .map((question, questionIndex) => ({
          question: (question.Question || "").trim(),
          answer: question.Answer || "",
          order:
            typeof question.Order === "number" && question.Order !== 0
              ? question.Order
              : questionIndex,
          isActive: question.IsActive !== false,
        })),
    }));
}

export function siteFaqHasQuestions(categories: unknown): boolean {
  if (!Array.isArray(categories)) return false;
  return categories.some((category) => {
    if (!category || typeof category !== "object") return false;
    const items = (category as { items?: unknown }).items;
    if (!Array.isArray(items)) return false;
    return items.some((item) => {
      if (!item || typeof item !== "object") return false;
      const question = (item as { question?: unknown }).question;
      return typeof question === "string" && question.trim().length > 0;
    });
  });
}
