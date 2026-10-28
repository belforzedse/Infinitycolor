import { normalizeDigits } from "@/utils/faNum";

export type ColorShades = [string, string, string, string];

export interface ColorFamilyDefinition {
  key: string;
  label: string;
  stems: string[];
  fallbackShades: ColorShades;
}

export interface CatalogColor {
  title: string;
  colorCode: string | null;
  /** Every exact-title relation ID, only present when the catalog supplied all of them. */
  ids?: number[];
}

export interface ColorFamilyBucket {
  key: string;
  label: string;
  titles: string[];
  shades: ColorShades;
}

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const COLOR_FAMILIES: ColorFamilyDefinition[] = [
  {
    key: "navy",
    label: "سرمه‌ای",
    stems: ["سرمه", "navy"],
    fallbackShades: ["#93C5FD", "#3B82F6", "#1E3A8A", "#010136"],
  },
  {
    key: "blue",
    label: "آبی",
    stems: ["آبی", "ابي", "blue"],
    fallbackShades: ["#D5F2FF", "#40AAFF", "#1D70C4", "#10265B"],
  },
  {
    key: "green",
    label: "سبز",
    stems: ["سبز", "زیتون", "یشمی", "سدری", "olive", "green"],
    fallbackShades: ["#E4F5DC", "#A8D98A", "#4C9A3A", "#1B4332"],
  },
  {
    key: "red",
    label: "قرمز",
    stems: ["قرمز", "زرشک", "گوجه", "آجر", "حنایی", "red"],
    fallbackShades: ["#FECACA", "#F87171", "#DC2626", "#6A1313"],
  },
  {
    key: "pink",
    label: "صورتی",
    stems: ["صورتی", "سرخاب", "گلبه", "یاسی", "pink"],
    fallbackShades: ["#FCE4EC", "#F9A8D4", "#F50057", "#9D174D"],
  },
  {
    key: "yellow",
    label: "زرد",
    stems: ["زرد", "خردل", "yellow"],
    fallbackShades: ["#FEF9C3", "#FFEB3B", "#EAB308", "#854D0E"],
  },
  {
    key: "orange",
    label: "نارنجی",
    stems: ["نارنج", "orange"],
    fallbackShades: ["#FFEDD5", "#FDBA74", "#F97316", "#9A3412"],
  },
  {
    key: "purple",
    label: "بنفش",
    stems: ["بنفش", "بادمجان", "purple"],
    fallbackShades: ["#E9D5FF", "#D05CE3", "#9C27B1", "#341941"],
  },
  {
    key: "white",
    label: "سفید",
    stems: ["سفید", "استخوان", "white"],
    fallbackShades: ["#FFFFFF", "#F8FAFC", "#E2E8F0", "#CBD5E1"],
  },
  {
    key: "black",
    label: "مشکی",
    stems: ["مشکی", "ذغال", "زغال", "black"],
    fallbackShades: ["#A3A3A3", "#525252", "#2F2F2F", "#111111"],
  },
  {
    key: "gray",
    label: "طوسی",
    stems: ["طوسی", "خاکستر", "دودی", "gray", "grey"],
    fallbackShades: ["#E5E7EB", "#9E9E9E", "#696969", "#374151"],
  },
  {
    key: "cream",
    label: "کرم",
    stems: ["کرم", "شیری", "cream"],
    fallbackShades: ["#FFFBEB", "#FFDEAD", "#EDE4D4", "#C2A986"],
  },
  {
    key: "khaki",
    label: "خاکی",
    stems: ["خاکی", "khaki"],
    fallbackShades: ["#F5F0E6", "#CEC1B1", "#A89F7C", "#6B5E4A"],
  },
  {
    key: "brown",
    label: "قهوه‌ای",
    stems: ["قهوه", "نسکافه", "شکلات", "brown"],
    fallbackShades: ["#E8D5C4", "#C4A484", "#8B5E3C", "#4A2C1A"],
  },
  {
    key: "gold",
    label: "طلایی",
    stems: ["طلایی", "gold"],
    fallbackShades: ["#FEF3C7", "#FBBF24", "#D97706", "#92400E"],
  },
  {
    key: "silver",
    label: "نقره‌ای",
    stems: ["نقره", "silver"],
    fallbackShades: ["#F8FAFC", "#E2E8F0", "#94A3B8", "#475569"],
  },
];

export const OTHER_COLOR_FAMILY: ColorFamilyDefinition = {
  key: "other",
  label: "سایر",
  stems: [],
  fallbackShades: ["#F4F4F5", "#D4D4D8", "#71717A", "#27272A"],
};

export function normalizeColorText(value: string): string {
  return normalizeDigits(value)
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .toLowerCase()
    .trim();
}

export function isHexColor(value: string | null | undefined): value is string {
  return Boolean(value && HEX_PATTERN.test(value.trim()));
}

export function expandHex(value: string): string {
  const hex = value.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const [, r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return hex.toLowerCase();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!isHexColor(hex)) return null;
  const full = expandHex(hex).slice(1);
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel)))
      .toString(16)
      .padStart(2, "0");
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const toLinear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

export function mixHex(hex: string, target: string, amount: number): string {
  const from = hexToRgb(hex);
  const to = hexToRgb(target);
  if (!from || !to) return expandHex(hex);
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex(
    from.r + (to.r - from.r) * t,
    from.g + (to.g - from.g) * t,
    from.b + (to.b - from.b) * t,
  );
}

export function buildFourShades(hexes: string[], fallback: ColorShades): ColorShades {
  const unique = [...new Set(hexes.filter(isHexColor).map(expandHex))].sort(
    (a, b) => relativeLuminance(b) - relativeLuminance(a),
  );

  if (unique.length === 0) return fallback;
  if (unique.length === 1) {
    const base = unique[0];
    return [mixHex(base, "#ffffff", 0.55), mixHex(base, "#ffffff", 0.22), base, mixHex(base, "#000000", 0.35)];
  }
  if (unique.length === 2) {
    return [
      mixHex(unique[0], "#ffffff", 0.35),
      unique[0],
      unique[1],
      mixHex(unique[1], "#000000", 0.28),
    ];
  }
  if (unique.length === 3) {
    return [unique[0], unique[1], unique[2], mixHex(unique[2], "#000000", 0.28)];
  }

  const last = unique.length - 1;
  return [
    unique[0],
    unique[Math.round(last / 3)],
    unique[Math.round((2 * last) / 3)],
    unique[last],
  ];
}

export function colorFamilyKeysFromTitle(title: string): string[] {
  const normalized = normalizeColorText(title);
  if (!normalized) return [];

  const matched = COLOR_FAMILIES.filter((family) =>
    family.stems.some((stem) => normalized.includes(normalizeColorText(stem))),
  ).map((family) => family.key);

  return matched;
}

export function colorFamilyLabel(key: string): string {
  if (key === OTHER_COLOR_FAMILY.key) return OTHER_COLOR_FAMILY.label;
  return COLOR_FAMILIES.find((family) => family.key === key)?.label ?? key;
}

export function buildColorFamilyBuckets(colors: CatalogColor[]): ColorFamilyBucket[] {
  const titlesByKey = new Map<string, string[]>();
  const hexesByKey = new Map<string, string[]>();
  const leftover: CatalogColor[] = [];

  const add = (key: string, color: CatalogColor) => {
    const titles = titlesByKey.get(key) ?? [];
    if (!titles.includes(color.title)) titles.push(color.title);
    titlesByKey.set(key, titles);
    if (isHexColor(color.colorCode)) {
      const hexes = hexesByKey.get(key) ?? [];
      hexes.push(color.colorCode);
      hexesByKey.set(key, hexes);
    }
  };

  for (const color of colors) {
    const keys = colorFamilyKeysFromTitle(color.title);
    if (keys.length === 0) {
      leftover.push(color);
      continue;
    }
    for (const key of keys) add(key, color);
  }

  const buckets: ColorFamilyBucket[] = [];
  for (const family of COLOR_FAMILIES) {
    const titles = titlesByKey.get(family.key);
    if (!titles?.length) continue;
    buckets.push({
      key: family.key,
      label: family.label,
      titles,
      shades: buildFourShades(hexesByKey.get(family.key) ?? [], family.fallbackShades),
    });
  }

  if (leftover.length > 0) {
    buckets.push({
      key: OTHER_COLOR_FAMILY.key,
      label: OTHER_COLOR_FAMILY.label,
      titles: leftover.map((color) => color.title),
      shades: buildFourShades(
        leftover.map((color) => color.colorCode).filter(isHexColor),
        OTHER_COLOR_FAMILY.fallbackShades,
      ),
    });
  }

  return buckets;
}

export function expandColorKeysToTitles(keys: string[], colors: CatalogColor[]): string[] {
  const wanted = new Set(keys.map((key) => normalizeColorText(key)).filter(Boolean));
  if (wanted.size === 0) return [];

  const titles = new Set<string>();
  for (const color of colors) {
    const familyKeys = colorFamilyKeysFromTitle(color.title);
    const belongsToOther = familyKeys.length === 0;
    const matches =
      familyKeys.some((key) => wanted.has(key)) ||
      (belongsToOther && wanted.has(OTHER_COLOR_FAMILY.key));
    if (matches) titles.add(color.title);
  }
  for (const key of keys) {
    if (key.trim()) titles.add(key);
  }
  return [...titles];
}

export function colorFamilyMatchesQuery(bucket: ColorFamilyBucket, query: string): boolean {
  const q = normalizeColorText(query);
  if (!q) return true;
  if (bucket.key.includes(q) || normalizeColorText(bucket.label).includes(q)) return true;
  if (bucket.titles.some((title) => normalizeColorText(title).includes(q))) return true;
  const family = COLOR_FAMILIES.find((item) => item.key === bucket.key);
  return Boolean(family?.stems.some((stem) => normalizeColorText(stem).includes(q) || q.includes(normalizeColorText(stem))));
}

export function conicGradientFromShades(shades: ColorShades): string {
  return `conic-gradient(${shades[0]} 0deg 90deg, ${shades[1]} 90deg 180deg, ${shades[2]} 180deg 270deg, ${shades[3]} 270deg 360deg)`;
}
