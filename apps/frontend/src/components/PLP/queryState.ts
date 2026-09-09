import { parseAsArrayOf, parseAsInteger, parseAsString } from "nuqs";

export const plpQueryParsers = {
  available: parseAsString,
  minPrice: parseAsString,
  maxPrice: parseAsString,
  size: parseAsArrayOf(parseAsString, ","),
  color: parseAsArrayOf(parseAsString, ","),
  material: parseAsString,
  season: parseAsString,
  gender: parseAsString,
  usage: parseAsString,
  sort: parseAsString,
  hasDiscount: parseAsString,
  page: parseAsInteger.withDefault(1),
} as const;

export const plpQueryOptions = {
  shallow: false,
  history: "push" as const,
} as const;

export function toggleFilterValue(current: string[] | null, key: string): string[] | null {
  const selected = current ?? [];
  const next = selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key];
  return next.length > 0 ? next : null;
}
