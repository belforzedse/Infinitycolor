import { faNum, normalizeDigits } from "@/utils/faNum";

export const CLOTHING_SIZE_KEYS = [
  "2xs",
  "xs",
  "s",
  "m",
  "l",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "6xl",
  "free",
] as const;

export type ClothingSizeKey = (typeof CLOTHING_SIZE_KEYS)[number];

export const CLOTHING_SIZE_LABELS: Record<ClothingSizeKey, string> = {
  "2xs": "2XS",
  xs: "XS",
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
  "2xl": "2XL",
  "3xl": "3XL",
  "4xl": "4XL",
  "5xl": "5XL",
  "6xl": "6XL",
  free: "فری سایز",
};

const CLOTHING_KEY_SET = new Set<string>(CLOTHING_SIZE_KEYS);

/** Known production aliases so a 3XL filter still matches when the catalog fetch is empty. */
export const STATIC_SIZE_ALIAS_TITLES = [
  "2xs",
  "xxs",
  "XXS",
  "xs",
  "S",
  "M",
  "L",
  "XL",
  "2xl",
  "2x",
  "XXL",
  "3xl",
  "XXXL",
  "4xl",
  "XXXXL",
  "5xl",
  "6XL",
  "2XL/3XL",
  "XL-2XL",
  "XL/2XL",
  "L-XL",
  "L/XL",
  "L/XL(2)",
  "M/L",
  "S/M",
  "S/M(1)",
  "فری سایز",
  "E2E Medium",
  "E2E Large",
] as const;

export type SizeBucketKind = "clothing" | "numeric" | "other";

export interface SizeBucket {
  key: string;
  kind: SizeBucketKind;
  label: string;
  titles: string[];
}

export function normalizeSizeInput(value: string): string {
  return normalizeDigits(value)
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .toLowerCase()
    .trim();
}

function stripSizeDecorations(value: string): string {
  return normalizeSizeInput(value)
    .replace(/سایز/g, " ")
    .replace(/\(\s*\d+\s*\)/g, " ")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactToken(value: string): string {
  return value.replace(/\s+/g, "");
}

function clothingKeyFromCompact(token: string): string | null {
  if (!token) return null;
  if (
    token === "free" ||
    token === "onesize" ||
    token === "فری" ||
    token === "فریسایز"
  ) {
    return "free";
  }

  const nx = token.match(/^(\d+)x$/);
  if (nx) {
    const n = Number(nx[1]);
    if (n === 1) return "xl";
    const key = `${n}xl`;
    return CLOTHING_KEY_SET.has(key) ? key : null;
  }

  if (token === "s" || token === "m" || token === "l" || token === "xl" || token === "xs") {
    return token;
  }

  const roman = token.match(/^(\d+)?(x+)(s|l)$/);
  if (roman) {
    const letter = roman[3];
    const xCount = roman[2].length;
    const numeric = roman[1] ? Number(roman[1]) : xCount;
    if (letter === "s") {
      if (numeric <= 1) return "xs";
      return CLOTHING_KEY_SET.has(`${numeric}xs`) ? `${numeric}xs` : "2xs";
    }
    if (numeric <= 1) return "xl";
    const key = `${numeric}xl`;
    return CLOTHING_KEY_SET.has(key) ? key : null;
  }

  return null;
}

function clothingKeysFromWords(normalized: string): string[] {
  const keys = new Set<string>();
  if (/(فری\s*سایز|free\s*size|one\s*size|onesize)/.test(normalized)) keys.add("free");
  if (/\b(xxxxl|4xl)\b/.test(normalized)) keys.add("4xl");
  if (/\b(xxxl|3xl)\b/.test(normalized)) keys.add("3xl");
  if (/\b(xxl|2xl|extra\s*extra\s*large)\b/.test(normalized)) keys.add("2xl");
  if (/\b(2xs|xxs|extra\s*extra\s*small)\b/.test(normalized)) keys.add("2xs");
  if (/\b(extra\s*small|x-small)\b/.test(normalized)) keys.add("xs");
  if (/\b(medium|med)\b/.test(normalized)) keys.add("m");
  if (/\b(extra\s*large)\b/.test(normalized)) keys.add("xl");
  if (/\blarge\b/.test(normalized) && !/\bextra\s*large\b/.test(normalized)) keys.add("l");
  if (/\bsmall\b/.test(normalized) && !/\bextra\s*small\b/.test(normalized)) keys.add("s");
  return [...keys];
}

function splitSizeParts(stripped: string): string[] {
  const compactish = stripped.trim();
  if (/^\d+\s*[/.]\s*\d$/.test(compactish)) {
    return [compactish.replace(/\s+/g, "").replace("/", ".")];
  }
  if (/[/_\-]/.test(compactish)) {
    return compactish
      .split(/[/_\-]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [compactish];
}

export function sizeKeysFromTitle(title: string): string[] {
  const normalized = normalizeSizeInput(title);
  if (!normalized) return [];

  const stripped = stripSizeDecorations(title);
  const parts = splitSizeParts(stripped);
  const keys = new Set<string>();

  for (const part of parts) {
    const compact = compactToken(part);
    const clothing = clothingKeyFromCompact(compact);
    if (clothing) {
      keys.add(clothing);
      continue;
    }

    const numeric = compact.replace(",", ".");
    if (/^\d+(?:\.\d+)?$/.test(numeric)) {
      keys.add(numeric.replace(/\.0$/, ""));
    }
  }

  if (keys.size === 0) {
    clothingKeysFromWords(normalized).forEach((key) => keys.add(key));
  }

  return [...keys];
}

export function sizeFilterChipLabel(key: string): string {
  if (key in CLOTHING_SIZE_LABELS) {
    return CLOTHING_SIZE_LABELS[key as ClothingSizeKey];
  }
  if (/^\d+(?:\.\d+)?$/.test(key)) {
    return faNum(key);
  }
  return key;
}

export function buildSizeBuckets(catalogTitles: string[]): SizeBucket[] {
  const byKey = new Map<string, string[]>();

  const add = (key: string, title: string) => {
    const current = byKey.get(key);
    if (current) {
      if (!current.includes(title)) current.push(title);
      return;
    }
    byKey.set(key, [title]);
  };

  for (const title of catalogTitles) {
    const keys = sizeKeysFromTitle(title);
    if (keys.length === 0) {
      add(`raw:${title}`, title);
      continue;
    }
    for (const key of keys) add(key, title);
  }

  const clothing: SizeBucket[] = [];
  for (const key of CLOTHING_SIZE_KEYS) {
    const titles = byKey.get(key);
    if (!titles?.length) continue;
    clothing.push({
      key,
      kind: "clothing",
      label: CLOTHING_SIZE_LABELS[key],
      titles,
    });
    byKey.delete(key);
  }

  const numeric: SizeBucket[] = [];
  const other: SizeBucket[] = [];
  for (const [key, titles] of byKey.entries()) {
    if (key.startsWith("raw:")) {
      const rawKey = key.slice(4);
      other.push({ key: rawKey, kind: "other", label: rawKey, titles });
      continue;
    }
    numeric.push({
      key,
      kind: "numeric",
      label: faNum(key),
      titles,
    });
  }
  numeric.sort((a, b) => Number(a.key) - Number(b.key));

  return [...clothing, ...numeric, ...other];
}

export function expandSizeKeysToTitles(keys: string[], catalogTitles: string[] = []): string[] {
  const wanted = new Set(keys.map((key) => normalizeSizeInput(key)).filter(Boolean));
  if (wanted.size === 0) return [];

  const titles = new Set<string>();
  const pool = new Set<string>([...STATIC_SIZE_ALIAS_TITLES, ...catalogTitles, ...keys]);
  for (const title of pool) {
    const mapped = sizeKeysFromTitle(title);
    if (mapped.some((key) => wanted.has(normalizeSizeInput(key)))) {
      titles.add(title);
    }
  }
  for (const key of keys) {
    if (key.trim()) titles.add(key);
  }
  return [...titles];
}

export function sizeBucketMatchesQuery(bucket: SizeBucket, query: string): boolean {
  const q = normalizeSizeInput(query);
  if (!q) return true;
  if (bucket.key.includes(q) || normalizeSizeInput(bucket.label).includes(q)) return true;
  if (bucket.titles.some((title) => normalizeSizeInput(title).includes(q))) return true;
  return sizeKeysFromTitle(q).includes(bucket.key);
}
