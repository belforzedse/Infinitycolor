export type BehaviorDimension =
  | "generic"
  | "path"
  | "channel"
  | "event"
  | "domain"
  | "referrer"
  | "device"
  | "browser"
  | "os"
  | "language"
  | "country"
  | "region"
  | "city"
  | "tag";

type AnalyticsRow = Record<string, unknown>;

const CHANNEL_LABELS: Record<string, string> = {
  direct: "ورود مستقیم",
  llm: "ابزارهای هوش مصنوعی",
  paidads: "تبلیغات کلیکی",
  organicsearch: "جست‌وجوی رایگان",
  paidsearch: "تبلیغات در نتایج جست‌وجو",
  organicsocial: "شبکه‌های اجتماعی",
  paidsocial: "تبلیغات شبکه‌های اجتماعی",
  organicshopping: "مقایسه‌گرهای خرید",
  paidshopping: "تبلیغات فروشگاهی",
  organicvideo: "سایت‌های ویدئویی",
  paidvideo: "تبلیغات ویدئویی",
  email: "ایمیل",
  referral: "سایت‌های دیگر",
  affiliate: "همکاران فروش",
  sms: "پیامک",
  push: "اعلان",
};

const EVENT_LABELS: Record<string, string> = {
  view_item: "مشاهده محصول",
  view_item_list: "مشاهده فهرست محصولات",
  select_item: "انتخاب محصول از فهرست",
  add_to_cart: "افزودن به سبد خرید",
  click_add_to_cart: "کلیک روی افزودن به سبد",
  remove_from_cart: "حذف از سبد خرید",
  update_quantity: "تغییر تعداد در سبد",
  view_cart: "مشاهده سبد خرید",
  begin_checkout: "شروع ثبت سفارش",
  add_shipping_info: "ثبت روش ارسال",
  add_payment_info: "انتخاب روش پرداخت",
  place_order_attempt: "تلاش برای ثبت سفارش",
  payment_redirect: "انتقال به درگاه پرداخت",
  payment_failed: "پرداخت ناموفق",
  payment_cancelled: "لغو پرداخت توسط خریدار",
  payment_unresolved: "نتیجه پرداخت نامشخص ماند",
  order_paid: "پرداخت تأییدشده در سرور",
  payment_completed: "تکمیل پرداخت (نسخه قدیم)",
  payment_callback_success: "بازگشت موفق از درگاه",
  payment_callback_failed: "بازگشت ناموفق از درگاه",
  payment_callback_error: "خطا در بازگشت از درگاه",
  order_success_page_view: "مشاهده صفحه خرید موفق",
  order_failure_page_view: "مشاهده صفحه پرداخت ناموفق",
  purchase: "خرید موفق (تأییدشده)",
  refund: "بازپرداخت",
  refund_irr: "بازپرداخت",
  login: "ورود به حساب",
  account_created: "ساخت حساب کاربری",
  sign_up: "ساخت حساب کاربری",
  site_search: "جست‌وجو در فروشگاه",
  search: "جست‌وجو در فروشگاه",
  share_product: "اشتراک‌گذاری محصول",
  open_comments: "مشاهده نظرهای محصول",
  add_to_wishlist: "افزودن به علاقه‌مندی‌ها",
  remove_from_wishlist: "حذف از علاقه‌مندی‌ها",
  apply_coupon: "استفاده از کد تخفیف",
  content_impression: "نمایش محتوای پیشنهادی",
  content_interaction: "تعامل با محتوای پیشنهادی",
  checkout_error: "خطا هنگام ثبت سفارش",
  adaptive_quality_tier_change: "تغییر خودکار کیفیت نمایش",
  adaptive_quality_recovery_step: "بازیابی کیفیت نمایش",
  adaptive_quality_route_summary: "خلاصه کیفیت صفحه",
  adaptive_quality_web_vital_cls: "اندازه‌گیری CLS",
  adaptive_quality_web_vital_fcp: "اندازه‌گیری FCP",
  adaptive_quality_web_vital_inp: "اندازه‌گیری INP",
  adaptive_quality_web_vital_lcp: "اندازه‌گیری LCP",
  adaptive_quality_web_vital_ttfb: "اندازه‌گیری TTFB",
};

const DEVICE_LABELS: Record<string, string> = {
  desktop: "رایانه رومیزی",
  laptop: "رایانه همراه",
  mobile: "موبایل",
  phone: "موبایل",
  tablet: "تبلت",
  smarttv: "تلویزیون هوشمند",
  console: "کنسول بازی",
  wearable: "دستگاه پوشیدنی",
};

const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  chromium: "Chromium",
  edge: "Microsoft Edge",
  firefox: "Firefox",
  opera: "Opera",
  safari: "Safari",
  samsung: "Samsung Internet",
  "samsung internet": "Samsung Internet",
  yandex: "Yandex Browser",
};

const OS_LABELS: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  ipados: "iPadOS",
  linux: "Linux",
  macos: "macOS",
  "mac os": "macOS",
  windows: "Windows",
  chromeos: "ChromeOS",
};

const CITY_LABELS: Record<string, string> = {
  tehran: "تهران",
  mashhad: "مشهد",
  isfahan: "اصفهان",
  esfahan: "اصفهان",
  shiraz: "شیراز",
  tabriz: "تبریز",
  karaj: "کرج",
  qom: "قم",
  ahvaz: "اهواز",
  rasht: "رشت",
  kerman: "کرمان",
  yazd: "یزد",
  urmia: "ارومیه",
  orumiyeh: "ارومیه",
  hamadan: "همدان",
  arak: "اراک",
  "bandar abbas": "بندرعباس",
  gorgan: "گرگان",
  sari: "ساری",
  babol: "بابل",
  amol: "آمل",
  qazvin: "قزوین",
  zanjan: "زنجان",
  ardabil: "اردبیل",
  sanandaj: "سنندج",
  kermanshah: "کرمانشاه",
  "khorramabad": "خرم‌آباد",
  bojnurd: "بجنورد",
  semnan: "سمنان",
  zahedan: "زاهدان",
  bushehr: "بوشهر",
  "gonbad-e kavus": "گنبد کاووس",
};

const IRAN_REGION_LABELS: Record<string, string> = {
  "00": "مرکزی",
  "01": "گیلان",
  "02": "مازندران",
  "03": "آذربایجان شرقی",
  "04": "آذربایجان غربی",
  "05": "کرمانشاه",
  "06": "خوزستان",
  "07": "فارس",
  "08": "کرمان",
  "09": "خراسان رضوی",
  "10": "اصفهان",
  "11": "سیستان و بلوچستان",
  "12": "کردستان",
  "13": "همدان",
  "14": "چهارمحال و بختیاری",
  "15": "لرستان",
  "16": "ایلام",
  "17": "کهگیلویه و بویراحمد",
  "18": "بوشهر",
  "19": "زنجان",
  "20": "سمنان",
  "21": "یزد",
  "22": "هرمزگان",
  "23": "تهران",
  "24": "اردبیل",
  "25": "قم",
  "26": "قزوین",
  "27": "گلستان",
  "28": "خراسان شمالی",
  "29": "خراسان جنوبی",
  "30": "البرز",
};

const ROUTE_LABELS: Record<string, string> = {
  "": "صفحه اصلی",
  home: "صفحه اصلی",
  shop: "فهرست محصولات",
  store: "فهرست محصولات",
  plp: "فهرست محصولات",
  cart: "سبد خرید",
  checkout: "ثبت سفارش",
  payment: "پرداخت",
  auth: "ورود و ثبت‌نام",
  login: "ورود به حساب",
  register: "ساخت حساب کاربری",
  account: "حساب کاربری",
  profile: "حساب کاربری",
  "my-account": "حساب کاربری",
  orders: "سفارش‌های من",
  order: "جزئیات سفارش",
  search: "نتیجه جست‌وجو",
  wishlist: "علاقه‌مندی‌ها",
  likes: "علاقه‌مندی‌ها",
  blog: "مجله",
  magazine: "مجله",
  فروشگاه: "فهرست محصولات",
  محصولات: "فهرست محصولات",
  پرداخت: "پرداخت",
};

function normalizedKey(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase("en-US");
}

function decodePathValue(value: string): string {
  let decoded = value.trim();
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded.split(/[?#]/, 1)[0] || "/";
}

function readableSlug(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

export function presentPath(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "/") return "صفحه اصلی";
  const decoded = decodePathValue(raw);
  const segments = decoded
    .replace(/^https?:\/\/[^/]+/i, "")
    .split("/")
    .filter(Boolean);
  if (!segments.length) return "صفحه اصلی";
  const root = normalizedKey(segments[0]);
  const detail = readableSlug(segments.slice(1).join(" "));
  if (["product", "products", "pdp", "محصول"].includes(root)) {
    return detail ? `محصول: ${detail}` : "صفحه محصول";
  }
  if (["category", "categories", "دسته", "دسته‌بندی"].includes(root)) {
    return detail ? `دسته‌بندی: ${detail}` : "دسته‌بندی محصولات";
  }
  if (ROUTE_LABELS[root]) return ROUTE_LABELS[root];
  return segments.map(readableSlug).filter(Boolean).join(" ← ") || "صفحه نامشخص";
}

function presentCountry(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "کشور نامشخص";
  if (/^[A-Za-z]{2}$/.test(raw)) {
    try {
      return new Intl.DisplayNames(["fa-IR"], { type: "region" }).of(raw.toUpperCase()) || raw;
    } catch {
      return raw.toUpperCase();
    }
  }
  return raw;
}

function presentLanguage(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "زبان نامشخص";
  const [language, region] = raw.replace("_", "-").split("-");
  try {
    const languageName = new Intl.DisplayNames(["fa-IR"], { type: "language" }).of(
      language.toLowerCase(),
    );
    const regionName = region
      ? new Intl.DisplayNames(["fa-IR"], { type: "region" }).of(region.toUpperCase())
      : null;
    return [languageName, regionName ? `(${regionName})` : null].filter(Boolean).join(" ") || raw;
  } catch {
    return raw;
  }
}

function presentReferrer(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || ["direct", "(direct)", "none"].includes(normalizedKey(raw))) return "ورود مستقیم";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./i, "");
  } catch {
    return raw.replace(/^www\./i, "");
  }
}

function presentTag(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "بدون برچسب";
  const [kind, ...rest] = raw.split(":");
  const detail = rest.join(":").trim();
  if (kind === "release" && detail) return `نسخه ${detail}`;
  if (kind === "experiment" && detail) return `آزمایش ${detail}`;
  return raw;
}

export function presentBehaviorValue(
  value: unknown,
  dimension: BehaviorDimension = "generic",
): string {
  const raw = String(value ?? "").trim();
  const key = normalizedKey(raw);
  if (dimension === "path") return presentPath(raw);
  if (dimension === "channel") {
    return CHANNEL_LABELS[key.replace(/[-_\s]/g, "")] ?? (raw || "منبع نامشخص");
  }
  if (dimension === "event") {
    return EVENT_LABELS[key] ?? (raw.replace(/_/g, " ") || "اقدام نامشخص");
  }
  if (dimension === "device") {
    return DEVICE_LABELS[key.replace(/[-_\s]/g, "")] ?? (raw || "دستگاه نامشخص");
  }
  if (dimension === "browser") return BROWSER_LABELS[key] ?? (raw || "مرورگر نامشخص");
  if (dimension === "os") {
    return OS_LABELS[key.replace(/[-_]/g, " ")] ?? (raw || "سیستم‌عامل نامشخص");
  }
  if (dimension === "language") return presentLanguage(raw);
  if (dimension === "country") return presentCountry(raw);
  if (dimension === "region") {
    const regionCode = raw.toUpperCase().replace(/^IR-/, "");
    return IRAN_REGION_LABELS[regionCode] ?? (raw || "استان نامشخص");
  }
  if (dimension === "city") return CITY_LABELS[key] ?? (raw || "شهر نامشخص");
  if (dimension === "domain" || dimension === "referrer") return presentReferrer(raw);
  if (dimension === "tag") return presentTag(raw);
  return (
    CHANNEL_LABELS[key.replace(/[-_\s]/g, "")] ??
    EVENT_LABELS[key] ??
    (raw || "نامشخص")
  );
}

/**
 * Umami journeys mix page views (a path) and custom events (a name) in one
 * sequence; present each with its own vocabulary.
 */
export function presentJourneyStep(value: unknown): string {
  const raw = String(value ?? "").trim();
  return raw.startsWith("/") ? presentPath(raw) : presentBehaviorValue(raw, "event");
}

/** Funnel window in minutes, as Persian words («۱ ساعت», «۲۴ ساعت», «۳۰ دقیقه»). */
export function presentWindow(minutes: unknown): string | null {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return null;
  const format = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
  if (value % 1440 === 0 && value > 1440) return `${format(value / 1440)} روز`;
  if (value % 60 === 0) return `${format(value / 60)} ساعت`;
  return `${format(value)} دقیقه`;
}

/** The checkout-side events the conversion tab lists; product browsing lives elsewhere. */
export const CHECKOUT_EVENT_NAMES: ReadonlySet<string> = new Set([
  "view_cart",
  "begin_checkout",
  "add_shipping_info",
  "add_payment_info",
  "apply_coupon",
  "place_order_attempt",
  "payment_redirect",
  "purchase",
  "payment_failed",
  "payment_cancelled",
  "payment_unresolved",
  "checkout_error",
  "order_paid",
  "refund",
]);

/** Events offered in the filter picker, in funnel order, with Persian labels. */
export const FILTERABLE_EVENTS: ReadonlyArray<{ value: string; label: string }> = [
  "view_item_list",
  "select_item",
  "view_item",
  "click_add_to_cart",
  "add_to_cart",
  "remove_from_cart",
  "update_quantity",
  "view_cart",
  "begin_checkout",
  "add_shipping_info",
  "add_payment_info",
  "apply_coupon",
  "place_order_attempt",
  "payment_redirect",
  "purchase",
  "payment_failed",
  "payment_cancelled",
  "payment_unresolved",
  "checkout_error",
  "site_search",
  "add_to_wishlist",
  "share_product",
  "open_comments",
].map((value) => ({ value, label: EVENT_LABELS[value] ?? value }));

export function performanceP75(value: unknown): number | null {
  const candidate =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as AnalyticsRow).p75
      : value;
  if (candidate === null || candidate === undefined || candidate === "") return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

export function measuredPerformanceRows(value: unknown): AnalyticsRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is AnalyticsRow => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const name = (row as AnalyticsRow).name;
    return typeof name === "string" && name.trim().length > 0 && performanceP75(row) !== null;
  });
}

const SECTION_LABELS: Record<string, string> = {
  summary: "آمار اصلی",
  path: "صفحه‌ها",
  channel: "منابع ورود",
  event: "اقدام‌های کاربران",
  utm: "کمپین‌های تبلیغاتی",
  firstAttribution: "اولین منبع ورود خریداران",
  lastAttribution: "آخرین منبع پیش از خرید",
  purchaseGoal: "خریدهای ثبت‌شده",
  discoveryFunnel: "مسیر محصول تا ثبت سفارش",
  checkoutFunnel: "مسیر ثبت سفارش تا خرید",
  paymentFunnel: "مسیر درگاه تا خرید",
  commerce: "فروش فروشگاه",
  journeys: "مسیر حرکت کاربران",
  retention: "بازگشت کاربران",
  performance: "سرعت صفحه",
};

export function presentAnalyticsMessage(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "بخشی از اطلاعات این گزارش در دسترس نیست.";
  const sectionMatch = /^بخش\s+([A-Za-z][A-Za-z0-9_]*)\s+در دسترس نیست$/.exec(raw);
  if (sectionMatch) {
    return `${SECTION_LABELS[sectionMatch[1]] ?? "بخشی از گزارش"} موقتاً در دسترس نیست.`;
  }
  if (/realtime.*unavailable/i.test(raw)) return "آمار لحظه‌ای موقتاً در دسترس نیست؛ آخرین اطلاعات موفق نمایش داده شده است.";
  // Must precede the generic /INVALID_/ branch below, which would otherwise
  // flatten this into "temporarily unavailable" — a bad range is not an outage,
  // and waiting will not fix it.
  if (/INVALID_DATE_RANGE/i.test(raw)) return "بازه تاریخ انتخاب‌شده معتبر نیست؛ تاریخ شروع و پایان را بررسی کنید.";
  if (/UMAMI_TIMEOUT|AbortError|timed?\s*out/i.test(raw)) return "دریافت آمار بیش از حد معمول طول کشید. دوباره تلاش کنید.";
  if (/UMAMI_AUTH|unauthorized|forbidden/i.test(raw)) return "دسترسی گزارش‌گیری نیاز به بررسی مدیر سیستم دارد.";
  // Checked before the generic unavailable branch: a missing configuration
  // never clears by waiting, so the banner must point at the operator instead
  // of implying a transient outage.
  if (/UMAMI_CONFIG_MISSING/i.test(raw))
    return "سامانه آمار بازدید تنظیم نشده است. تنظیمات آن باید توسط مدیر سیستم انجام شود.";
  if (/UMAMI_UNAVAILABLE|collector offline|fetch failed|ECONN/i.test(raw)) return "سامانه آمار بازدید موقتاً در دسترس نیست.";
  if (/\bUmami\b|\bAPI\b|UMAMI_|HTTP_\d+|INVALID_|API_/i.test(raw))
    return "بخشی از اطلاعات این گزارش موقتاً در دسترس نیست.";
  return raw.length <= 120 ? raw : "بخشی از اطلاعات این گزارش موقتاً در دسترس نیست.";
}
