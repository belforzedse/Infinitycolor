import type { ProductCategorySummary } from "@/services/product/categories";

export type CategoryGroupDefinition = {
  key: string;
  label: string;
  terms: readonly string[];
};

export type GroupedCategoryOption = {
  id: string;
  title: string;
  categoryId: number;
  parentTitle?: string;
  depth: number;
};

export type GroupedCategorySection = {
  key: string;
  title: string;
  options: GroupedCategoryOption[];
  source: "mobile" | "parent" | "other";
};

export type MobileCategoryGroup = CategoryGroupDefinition & {
  categories: ProductCategorySummary[];
};

export const MOBILE_CATEGORY_GROUPS: readonly CategoryGroupDefinition[] = [
  {
    key: "upper-body",
    label: "بالاتنه",
    terms: ["مانتو", "coat-and-mantle", "شومیز", "paperback-and-tonic", "پیراهن", "shirt"],
  },
  {
    key: "lower-body",
    label: "پایین‌تنه",
    terms: ["شلوار", "pants", "دامن", "skirt"],
  },
  {
    key: "shoes-accessories",
    label: "کفش و اکسسوری",
    terms: [
      "انواع کفش",
      "کفش",
      "shoes",
      "شال",
      "shawls-and-scarves",
      "جوراب",
      "socks",
      "womens-belt",
    ],
  },
  {
    key: "mens-clothing",
    label: "لباس مردانه",
    terms: ["لباس مردانه", "مردانه", "mens-clothing", "men-clothing", "mens"],
  },
  {
    key: "other-clothing",
    label: "سایر لباس‌ها",
    terms: [
      "لباس‌های زمستانه",
      "لباس زمستانه",
      "winter",
      "لباس زیر",
      "under-wear",
      "راحتی",
      "house-dress",
    ],
  },
];

export const FALLBACK_MOBILE_CATEGORY_GROUP_KEY = "other-clothing";

const OTHER_CATEGORY_LABEL = "سایر";

export const normalizeCategoryText = (value: string) =>
  value
    .trim()
    .toLocaleLowerCase("fa-IR")
    .replace(/\u200c/g, " ")
    .replace(/\s+/g, " ");

export function categoryMatchesGroup(
  category: ProductCategorySummary,
  group: CategoryGroupDefinition,
) {
  const name = normalizeCategoryText(category.name);
  const slug = normalizeCategoryText(category.slug);

  return group.terms.some((term) => {
    const normalizedTerm = normalizeCategoryText(term);
    return (
      name === normalizedTerm ||
      name.includes(normalizedTerm) ||
      slug === normalizedTerm ||
      slug.includes(normalizedTerm)
    );
  });
}

export function buildMobileCategoryGroups(
  categories: ProductCategorySummary[],
  options: { includeFallback?: boolean } = {},
): MobileCategoryGroup[] {
  const includeFallback = options.includeFallback ?? true;
  const grouped = new Map<string, ProductCategorySummary[]>(
    MOBILE_CATEGORY_GROUPS.map((group) => [group.key, []]),
  );

  for (const category of categories) {
    const matchingGroup =
      MOBILE_CATEGORY_GROUPS.find((group) => categoryMatchesGroup(category, group)) ??
      (includeFallback
        ? MOBILE_CATEGORY_GROUPS.find((group) => group.key === FALLBACK_MOBILE_CATEGORY_GROUP_KEY)
        : undefined);

    if (!matchingGroup) continue;
    grouped.get(matchingGroup.key)?.push(category);
  }

  return MOBILE_CATEGORY_GROUPS.map((group) => ({
    ...group,
    categories: grouped.get(group.key) ?? [],
  })).filter((group) => group.categories.length > 0);
}

function flattenCategories(categories: ProductCategorySummary[]): ProductCategorySummary[] {
  const byId = new Map<number, ProductCategorySummary>();

  const addCategory = (category: ProductCategorySummary, parentId: number | null = null) => {
    const normalized =
      parentId !== null && category.parentId === null ? { ...category, parentId } : category;
    const existing = byId.get(normalized.id);
    byId.set(normalized.id, existing ? { ...normalized, children: existing.children } : normalized);

    for (const child of category.children ?? []) {
      addCategory(child, normalized.id);
    }
  };

  for (const category of categories) {
    addCategory(category);
  }

  return Array.from(byId.values());
}

function buildChildrenByParent(categories: ProductCategorySummary[]) {
  const childrenByParent = new Map<number, ProductCategorySummary[]>();

  for (const category of categories) {
    if (category.parentId === null) continue;
    const current = childrenByParent.get(category.parentId) ?? [];
    current.push(category);
    childrenByParent.set(category.parentId, current);
  }

  return childrenByParent;
}

function buildOptionsForCategory(
  category: ProductCategorySummary,
  childrenByParent: Map<number, ProductCategorySummary[]>,
  depth = 0,
  parentTitle?: string,
): GroupedCategoryOption[] {
  const children = childrenByParent.get(category.id) ?? [];
  const options: GroupedCategoryOption[] = [
    {
      id: category.slug || String(category.id),
      title: category.name || category.slug || String(category.id),
      categoryId: category.id,
      parentTitle,
      depth,
    },
  ];

  for (const child of children) {
    options.push(...buildOptionsForCategory(child, childrenByParent, depth + 1, category.name));
  }

  return options;
}

function categoryOrDescendantMatchesGroup(
  category: ProductCategorySummary,
  childrenByParent: Map<number, ProductCategorySummary[]>,
  group: CategoryGroupDefinition,
): boolean {
  if (categoryMatchesGroup(category, group)) return true;

  const children = childrenByParent.get(category.id) ?? [];
  return children.some((child) => categoryOrDescendantMatchesGroup(child, childrenByParent, group));
}

export function buildGroupedCategorySections(
  categories: ProductCategorySummary[],
): GroupedCategorySection[] {
  const flatCategories = flattenCategories(categories);
  const byId = new Map(flatCategories.map((category) => [category.id, category]));
  const childrenByParent = buildChildrenByParent(flatCategories);
  const roots = flatCategories.filter(
    (category) => category.parentId === null || !byId.has(category.parentId),
  );
  const usedIds = new Set<number>();
  const sections: GroupedCategorySection[] = [];

  for (const group of MOBILE_CATEGORY_GROUPS) {
    const matchingRoots = roots.filter(
      (category) =>
        !usedIds.has(category.id) &&
        categoryOrDescendantMatchesGroup(category, childrenByParent, group),
    );

    if (matchingRoots.length === 0) continue;

    const options = matchingRoots.flatMap((category) =>
      buildOptionsForCategory(category, childrenByParent),
    );
    for (const option of options) {
      usedIds.add(option.categoryId);
    }

    sections.push({
      key: `mobile-${group.key}`,
      title: group.label,
      options,
      source: "mobile",
    });
  }

  const otherOptions: GroupedCategoryOption[] = [];
  for (const root of roots) {
    if (usedIds.has(root.id)) continue;

    const options = buildOptionsForCategory(root, childrenByParent).filter(
      (option) => !usedIds.has(option.categoryId),
    );
    if (options.length === 0) continue;

    for (const option of options) {
      usedIds.add(option.categoryId);
    }

    const hasChildren = options.length > 1;
    if (hasChildren) {
      sections.push({
        key: `parent-${root.id}`,
        title: root.name || root.slug || String(root.id),
        options,
        source: "parent",
      });
    } else {
      otherOptions.push(options[0]);
    }
  }

  if (otherOptions.length > 0) {
    sections.push({
      key: "other",
      title: OTHER_CATEGORY_LABEL,
      options: otherOptions,
      source: "other",
    });
  }

  return sections;
}
