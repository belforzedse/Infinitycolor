import {
  getAllCategories,
  type categoryResponseType,
} from "@/services/super-admin/product/category/getAll";

export const fetchCategoryDropdownOptions = async (
  searchTerm: string,
): Promise<Array<{ label: string; value: string }>> => {
  try {
    const response = await getAllCategories();
    let categories: categoryResponseType[] = [];
    const normalizedResponse: unknown = response;

    if (Array.isArray(normalizedResponse)) {
      categories = normalizedResponse as categoryResponseType[];
    } else if (normalizedResponse && typeof normalizedResponse === "object") {
      const root = normalizedResponse as { data?: unknown };
      if (Array.isArray(root.data)) {
        categories = root.data as categoryResponseType[];
      } else if (root.data && typeof root.data === "object") {
        const nested = root.data as { data?: unknown };
        if (Array.isArray(nested.data)) {
          categories = nested.data as categoryResponseType[];
        }
      }
    }

    const normalized = categories
      .map((category: categoryResponseType) => ({
        label: category.attributes?.Title?.trim() || category.attributes?.Slug?.trim() || "",
        value: category.attributes?.Slug?.trim() || "",
      }))
      .filter((category: { label: string; value: string }) => category.label && category.value);

    const query = searchTerm.trim().toLowerCase();
    const filtered = query
      ? normalized.filter(
          (category: { label: string; value: string }) =>
            category.label.toLowerCase().includes(query) ||
            category.value.toLowerCase().includes(query),
        )
      : normalized;

    return filtered.sort(
      (a: { label: string; value: string }, b: { label: string; value: string }) =>
        a.label.localeCompare(b.label, "fa"),
    );
  } catch {
    return [];
  }
};
