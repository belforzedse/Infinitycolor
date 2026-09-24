import type { BehaviorFilters } from "@/types/super-admin/reports/behavior";
import { PRODUCT_PROPERTY_FILTERS, SESSION_LEVEL_FILTERS } from "./presentation";

export const FILTER_LABELS: Record<keyof BehaviorFilters, string> = {
  path: "نشانی صفحه",
  referrer: "سایت ارجاع‌دهنده",
  title: "عنوان صفحه",
  os: "سیستم‌عامل",
  browser: "مرورگر",
  device: "دستگاه",
  country: "کشور",
  region: "استان / منطقه",
  city: "شهر",
  tag: "نسخه یا آزمایش فعال",
  hostname: "نشانی فروشگاه",
  language: "زبان",
  event: "نام اقدام کاربر",
  utmSource: "منبع تبلیغ",
  utmMedium: "روش انتشار تبلیغ",
  utmCampaign: "نام کمپین",
  utmContent: "نسخه محتوای تبلیغ",
  utmTerm: "عبارت تبلیغاتی",
  segment: "بخش کاربران (شناسه از پنل Umami)",
  cohort: "گروه زمانی کاربران (شناسه از پنل Umami)",
  excludeBounce: "حذف بازدیدهای تک‌صفحه‌ای",
  match: "روش ترکیب شرط‌ها",
  productId: "شناسه محصول",
  categoryId: "شناسه دسته",
  variantId: "شناسه مدل محصول",
};

export const URL_FILTER_KEYS = Object.keys(FILTER_LABELS) as (keyof BehaviorFilters)[];

/** The filters shown inline; everything else sits behind «فیلترهای بیشتر». */
export const PRIMARY_FILTERS: ReadonlyArray<keyof BehaviorFilters> = [
  "device",
  "os",
  "browser",
  "region",
];

export const SECONDARY_FILTER_GROUPS: ReadonlyArray<{
  title: string;
  note: string;
  keys: ReadonlyArray<keyof BehaviorFilters>;
}> = [
  {
    title: "بازدیدکننده",
    note: "روی همه بخش‌ها، از جمله قیف و نرخ تبدیل، اعمال می‌شوند.",
    keys: ["country", "city", "language"],
  },
  {
    title: "صفحه و منبع ورود",
    note: "روی بازدید، صفحه‌ها و منابع اعمال می‌شوند، نه روی قیف و نرخ تبدیل: در Umami به هر رخداد جداگانه تعلق دارند.",
    keys: [
      "path",
      "title",
      "referrer",
      "utmSource",
      "utmMedium",
      "utmCampaign",
      "utmContent",
      "utmTerm",
      "event",
      "tag",
    ],
  },
  {
    title: "محصول",
    note: "فقط شواهد محصول در بخش «صفحه‌ها و مسیرها» را محدود می‌کنند.",
    keys: ["productId", "categoryId", "variantId"],
  },
  {
    title: "تخصصی",
    note: "بخش‌ها و گروه‌های تعریف‌شده در پنل Umami و تنظیم ترکیب شرط‌ها.",
    keys: ["segment", "cohort", "match", "excludeBounce", "hostname"],
  },
];

export const DEVICE_OPTIONS = [
  { value: "mobile", label: "موبایل" },
  { value: "laptop", label: "رایانه همراه" },
  { value: "desktop", label: "رایانه رومیزی" },
  { value: "tablet", label: "تبلت" },
] as const;

export const OS_OPTIONS = [
  { value: "Android OS", label: "Android" },
  { value: "iOS", label: "iOS" },
  { value: "Windows 10", label: "Windows 10" },
  { value: "Mac OS", label: "macOS" },
  { value: "Linux", label: "Linux" },
] as const;

export const BROWSER_OPTIONS = [
  { value: "chrome", label: "Chrome" },
  { value: "ios", label: "Safari (آیفون)" },
  { value: "instagram", label: "مرورگر داخلی اینستاگرام" },
  { value: "chromium-webview", label: "مرورگر داخلی برنامه‌ها (اندروید)" },
  { value: "samsung", label: "Samsung Internet" },
  { value: "crios", label: "Chrome (آیفون)" },
  { value: "firefox", label: "Firefox" },
] as const;

export function filtersFromValues(values: Record<string, string>): BehaviorFilters {
  return Object.fromEntries(
    URL_FILTER_KEYS.flatMap((key) => (values[key] ? [[key, values[key]]] : [])),
  ) as BehaviorFilters;
}

export function activeFilterKeys(filters: BehaviorFilters): (keyof BehaviorFilters)[] {
  return URL_FILTER_KEYS.filter((key) => Boolean(filters[key]));
}

/** Where a filter applies, stated next to it rather than discovered from odd numbers. */
export function filterScopeText(key: keyof BehaviorFilters): string {
  if (SESSION_LEVEL_FILTERS.has(key)) return "همه بخش‌ها";
  if (PRODUCT_PROPERTY_FILTERS.has(key)) return "فقط شواهد محصول";
  return "بازدید و صفحه‌ها، نه قیف";
}
