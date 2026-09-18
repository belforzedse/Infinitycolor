import { MOBILE_TOP_LEVEL_CATEGORY_SLUGS } from "@/constants/categories";
import type { CategoryFilterOption } from "@/services/product/categories";
import { normalizeCategoryText } from "@/utils/categoryGroups";

export const SYNTHETIC_MOBILE_CATEGORY_ID_MAX = -21000;

export type MobileMenuTaxonomyGroup<T extends CategoryFilterOption = CategoryFilterOption> = {
  type: "group";
  key: string;
  label: string;
  categories: T[];
};

export type MobileMenuTaxonomyCategory<T extends CategoryFilterOption = CategoryFilterOption> = {
  type: "category";
  key: string;
  category: T;
};

export type MobileMenuTaxonomyItem<T extends CategoryFilterOption = CategoryFilterOption> =
  | MobileMenuTaxonomyGroup<T>
  | MobileMenuTaxonomyCategory<T>;

type MemberSpec = {
  key: string;
  label: string;
  slugs: readonly string[];
  names?: readonly string[];
  nameStartsWith?: string;
  excludeNameIncludes?: readonly string[];
};

type StandaloneSpec = {
  type: "category";
  key: string;
  label: string;
  slugs: readonly string[];
  names?: readonly string[];
  omitChildSlugs?: readonly string[];
};

type GroupSpec = {
  type: "group";
  key: string;
  label: string;
  members: readonly MemberSpec[];
};

type MenuSpecItem = GroupSpec | StandaloneSpec;

const MOBILE_MENU_SPEC: readonly MenuSpecItem[] = [
  {
    type: "group",
    key: "upper-body",
    label: "بالا تنه",
    members: [
      { key: "pullover", label: "پلیور", slugs: ["پلیور-و-بافت"], names: ["پلیور"] },
      {
        key: "coat-bomber",
        label: "کت و بامبر",
        slugs: ["بامبر", "jacket-and-puffer"],
        names: ["کت و بامبر", "بامبر"],
      },
      {
        key: "hoodie",
        label: "هودی و دورس",
        slugs: ["hoodie-and-dores", "دورس"],
        names: ["هودی و دورس", "هودی", "دورس"],
      },
      {
        key: "coat-mantle",
        label: "پالتو و مانتو",
        slugs: ["coat", "coat-and-mantle"],
        names: ["پالتو و مانتو", "پالتو", "مانتو"],
      },
      { key: "shirt", label: "پیراهن", slugs: ["shirt"], names: ["پیراهن"] },
      {
        key: "shomiz",
        label: "شومیز و تونیک",
        slugs: ["paperback-and-tonic"],
        names: ["شومیز و تونیک", "شومیز"],
      },
    ],
  },
  {
    type: "group",
    key: "lower-body",
    label: "پایین تنه",
    members: [
      { key: "pants", label: "شلوار", slugs: ["pants"], names: ["شلوار"] },
      { key: "shorts", label: "شلوارک", slugs: ["شوارک", "شلوارک"], names: ["شلوارک"] },
      { key: "skirt", label: "دامن", slugs: ["skirt"], names: ["دامن"] },
      { key: "leggings", label: "لگ", slugs: ["لگ"], names: ["لگ"] },
    ],
  },
  {
    type: "category",
    key: "shoes",
    label: "کفش",
    slugs: ["shoes"],
    names: ["کفش", "انواع کفش"],
  },
  {
    type: "category",
    key: "shawl",
    label: "شال",
    slugs: ["shawls-and-scarves"],
    names: ["شال"],
    omitChildSlugs: ["کلاه"],
  },
  { type: "category", key: "hat", label: "کلاه", slugs: ["کلاه"], names: ["کلاه"] },
  { type: "category", key: "socks", label: "جوراب", slugs: ["socks"], names: ["جوراب"] },
  {
    type: "category",
    key: "belt",
    label: "کمربند",
    slugs: ["womens-belt"],
    names: ["کمربند", "کمربند زنانه"],
  },
  {
    type: "group",
    key: "sportswear",
    label: "لباس ورزشی",
    members: [
      {
        key: "sports-bustier",
        label: "نیم تنه",
        slugs: ["match-bust"],
        names: ["نیم تنه"],
        nameStartsWith: "نیم تنه",
        excludeNameIncludes: ["ست"],
      },
      { key: "sports-leggings", label: "لگ", slugs: ["لگ"], names: ["لگ"] },
      { key: "sports-shorts", label: "شلوارک", slugs: ["شوارک", "شلوارک"], names: ["شلوارک"] },
      { key: "sports-skirt", label: "دامن", slugs: ["skirt"], names: ["دامن"] },
    ],
  },
  {
    type: "category",
    key: "underwear",
    label: "لباس زیر",
    slugs: ["under-wear"],
    names: ["لباس زیر"],
  },
];

type CategoryIndex<T extends CategoryFilterOption> = {
  all: T[];
  bySlug: Map<string, T>;
  byName: Map<string, T>;
};

export function isSyntheticMobileMenuCategory(category: Pick<CategoryFilterOption, "id">): boolean {
  return category.id <= SYNTHETIC_MOBILE_CATEGORY_ID_MAX;
}

function stableSyntheticId(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return SYNTHETIC_MOBILE_CATEGORY_ID_MAX - (Math.abs(hash) % 1000);
}

function indexCategories<T extends CategoryFilterOption>(categories: T[]): CategoryIndex<T> {
  const bySlug = new Map<string, T>();
  const byName = new Map<string, T>();
  const all: T[] = [];

  const visit = (category: T) => {
    all.push(category);
    if (!bySlug.has(category.slug)) bySlug.set(category.slug, category);
    const name = normalizeCategoryText(category.name);
    if (name && !byName.has(name)) byName.set(name, category);
    for (const child of category.children ?? []) {
      visit(child as T);
    }
  };

  for (const category of categories) {
    visit(category);
  }

  return { all, bySlug, byName };
}

function isExcludedName(name: string, excludeNameIncludes: readonly string[] | undefined) {
  if (!excludeNameIncludes?.length) return false;
  const normalized = normalizeCategoryText(name);
  return excludeNameIncludes.some((term) => normalized.includes(normalizeCategoryText(term)));
}

function resolveCategories<T extends CategoryFilterOption>(
  index: CategoryIndex<T>,
  spec: Pick<MemberSpec, "slugs" | "names" | "nameStartsWith" | "excludeNameIncludes">,
): T[] {
  const found: T[] = [];
  const seen = new Set<number>();

  const add = (category: T | undefined) => {
    if (!category || seen.has(category.id)) return;
    if (isExcludedName(category.name, spec.excludeNameIncludes)) return;
    seen.add(category.id);
    found.push(category);
  };

  for (const slug of spec.slugs) {
    add(index.bySlug.get(slug));
  }

  for (const name of spec.names ?? []) {
    add(index.byName.get(normalizeCategoryText(name)));
  }

  if (spec.nameStartsWith) {
    const prefix = normalizeCategoryText(spec.nameStartsWith);
    for (const category of index.all) {
      if (normalizeCategoryText(category.name).startsWith(prefix)) {
        add(category);
      }
    }
  }

  return found;
}

function withDisplayName<T extends CategoryFilterOption>(category: T, label: string): T {
  if (category.name === label) return category;
  return { ...category, name: label };
}

function omitChildren<T extends CategoryFilterOption>(
  category: T,
  omitChildSlugs: readonly string[] | undefined,
): T {
  if (!omitChildSlugs?.length) return category;
  const omitted = new Set(omitChildSlugs);
  const children = (category.children ?? []).filter((child) => !omitted.has(child.slug));
  if (children.length === (category.children ?? []).length) return category;
  return {
    ...category,
    children,
    ...(typeof (category as T & { hasChildren?: boolean }).hasChildren === "boolean"
      ? { hasChildren: children.length > 0 }
      : {}),
  };
}

function withoutNestedChildren<T extends CategoryFilterOption>(category: T): T {
  if (!category.children?.length) return category;
  return {
    ...category,
    children: undefined,
    ...(typeof (category as T & { hasChildren?: boolean }).hasChildren === "boolean"
      ? { hasChildren: false }
      : {}),
  };
}

function combineCategories<T extends CategoryFilterOption>(sources: T[], key: string, label: string): T {
  if (sources.length === 1) {
    return withDisplayName(sources[0], label);
  }

  const primary = sources[0];
  const children = sources.flatMap((source) => [
    withoutNestedChildren(source),
    ...((source.children ?? []) as T[]),
  ]);

  return {
    ...primary,
    id: stableSyntheticId(key),
    name: label,
    children,
    ...(typeof (primary as T & { hasChildren?: boolean }).hasChildren === "boolean"
      ? { hasChildren: children.length > 0 }
      : {}),
  };
}

function toMemberCategory<T extends CategoryFilterOption>(sources: T[], spec: MemberSpec): T | null {
  if (sources.length === 0) return null;
  return combineCategories(sources, spec.key, spec.label);
}

/**
 * Builds the mobile hamburger category tree from CMS categories.
 * Missing catalogue items are skipped rather than rendered empty.
 */
export function buildMobileMenuTaxonomy<T extends CategoryFilterOption>(
  categories: T[],
): MobileMenuTaxonomyItem<T>[] {
  const index = indexCategories(categories);
  const usedIds = new Set<number>();
  const items: MobileMenuTaxonomyItem<T>[] = [];

  const markUsed = (category: T) => {
    usedIds.add(category.id);
    if (isSyntheticMobileMenuCategory(category)) return;
    for (const child of category.children ?? []) {
      usedIds.add(child.id);
    }
  };

  for (const spec of MOBILE_MENU_SPEC) {
    if (spec.type === "group") {
      const groupCategories: T[] = [];
      for (const member of spec.members) {
        const resolved = resolveCategories(index, member);
        const category = toMemberCategory(resolved, member);
        if (!category) continue;
        groupCategories.push(category);
        for (const source of resolved) {
          markUsed(source);
        }
      }
      if (groupCategories.length === 0) continue;
      items.push({
        type: "group",
        key: spec.key,
        label: spec.label,
        categories: groupCategories,
      });
      continue;
    }

    const resolved = resolveCategories(index, spec);
    if (resolved.length === 0) continue;
    const category = omitChildren(withDisplayName(resolved[0], spec.label), spec.omitChildSlugs);
    items.push({
      type: "category",
      key: spec.key,
      category,
    });
    markUsed(resolved[0]);
  }

  for (const slug of MOBILE_TOP_LEVEL_CATEGORY_SLUGS) {
    const category = index.bySlug.get(slug);
    if (!category || usedIds.has(category.id)) continue;
    items.push({
      type: "category",
      key: `extra-${category.slug}`,
      category,
    });
    markUsed(category);
  }

  return items;
}
