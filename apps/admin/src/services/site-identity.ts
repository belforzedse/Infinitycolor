import { API_BASE_URL, getStrapiServerUrl, STRAPI_TOKEN } from "@/constants/api";
import type {
  ContactNumberType,
  IdentityContactNumber,
  IdentityPhone,
  IdentitySocialLink,
  IdentityStore,
  SiteIdentity,
  SocialPlatform,
} from "@/types/site-identity";
import { unwrapStrapiEntity, unwrapStrapiFields } from "@/utils/strapiEntity";

/**
 * Server-side fetcher for the `site-identity` single type.
 *
 * - Server Component friendly: tagged with `site-identity` for on-demand
 *   revalidation, with an ISR fallback window.
 * - Precise populate (no `populate=deep`).
 * - Returns safe defaults on 404/error so public pages never break.
 */

export const SITE_IDENTITY_TAG = "site-identity";

/**
 * Fallback identity mirrors the values the site used before this was CMS-driven
 * (see constants/footer.ts, config/site.ts and components/SEO/OrganizationSchema.tsx).
 * Used only when the database record is missing/unavailable.
 */
export const DEFAULT_SITE_IDENTITY: SiteIdentity = {
  siteName: "فروشگاه پوشاک اینفینیتی",
  brandDescription:
    "پوشاک اینفینیتی با عرضه پوشاک با بهترین قیمت و کیفیت همیشه سعی کرده است تا بهترین ها را برای شما به ارمغان بیاورد!",
  supportHours: "شنبه تا پنج شنبه (غیر از روزهای تعطیل) از ساعت9 صبح الی 17 پاسخگوی شما هستیم.",
  hasPhysicalStores: true,
  hasMultipleStores: true,
  stores: [
    {
      name: "گرگان",
      address: "گلستان، گرگان، بلوار ناهارخوران، نبش عدالت ۶۸",
      postalCode: "4916976618",
      phones: [{ label: "تلفن فروشگاه", number: "017-325-304-39" }],
      showInFooter: true,
      showInAbout: true,
      socialLinks: [],
    },
    {
      name: "گنبد کاووس",
      address: "گنبد کاووس، ابتدای بلوار دانشجو",
      phones: [],
      showInFooter: true,
      showInAbout: true,
      socialLinks: [],
    },
  ],
  socialLinks: [
    {
      platform: "instagram",
      url: "https://www.instagram.com/infinity.color_boutique/",
      label: "infinity.color_boutique",
    },
    { platform: "telegram", url: "https://t.me/InfinityColorShop", label: "InfinityColorShop" },
  ],
  contactNumbers: [
    { label: "تلفن", number: "017-325-304-39", type: "phone" },
    { label: "واتساپ", number: "0901-655-25-30", type: "whatsapp" },
  ],
};

/** Code fallback when the database site name is missing or empty. */
export const DEFAULT_SITE_NAME = DEFAULT_SITE_IDENTITY.siteName;

export function resolveSiteName(name?: string | null): string {
  return name?.trim() || DEFAULT_SITE_NAME;
}

export function blogMagTitle(siteName?: string | null): string {
  return `${resolveSiteName(siteName)} مگ`;
}

export const SITE_IDENTITY_POPULATE =
  "populate[stores][populate][phones]=true&populate[stores][populate][socialLinks]=true&populate[socialLinks]=true&populate[contactNumbers]=true";

const POPULATE_QUERY = SITE_IDENTITY_POPULATE;

const SOCIAL_PLATFORMS: readonly SocialPlatform[] = [
  "instagram",
  "telegram",
  "whatsapp",
  "bale",
  "x",
  "linkedin",
  "youtube",
  "aparat",
  "eitaa",
  "rubika",
  "other",
];

const CONTACT_NUMBER_TYPES: readonly ContactNumberType[] = ["phone", "mobile", "whatsapp"];

function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

function isContactNumberType(value: unknown): value is ContactNumberType {
  return typeof value === "string" && (CONTACT_NUMBER_TYPES as readonly string[]).includes(value);
}

function readText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export const GONBAD_KAVUS_STORE_NAME = "گنبد کاووس";

/** Repair mojibake / replacement-character spellings of the Gonbad store title. */
export function repairStoreDisplayName(name: string | undefined): string | undefined {
  if (!name) return name;
  if (name === GONBAD_KAVUS_STORE_NAME) return name;
  if (name.includes("\uFFFD") && name.includes("گنبد")) {
    return GONBAD_KAVUS_STORE_NAME;
  }
  const compact = name.replace(/[\s.\u200c\uFFFD]+/g, "");
  if (/^گنبد[کك][اآأٱ]?ووس$/.test(compact) || /^گنبد[کك]ووس$/.test(compact)) {
    return GONBAD_KAVUS_STORE_NAME;
  }
  return name;
}

function componentEntries(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      const fields = unwrapStrapiEntity(item) ?? unwrapStrapiFields(item);
      return fields ? [fields] : [];
    });
  }
  if (raw && typeof raw === "object" && "data" in raw) {
    const nested = (raw as { data: unknown }).data;
    if (Array.isArray(nested)) return componentEntries(nested);
  }
  return [];
}

function toSocialLinks(raw: unknown): IdentitySocialLink[] {
  return componentEntries(raw).flatMap((item) => {
    const url = readText(item.url);
    const platform = isSocialPlatform(item.platform)
      ? item.platform
      : item.platform
        ? "other"
        : undefined;
    if (!url || !platform) return [];
    return [
      {
        ...(typeof item.id === "number" ? { id: item.id } : {}),
        platform,
        url,
        label: readText(item.label),
      },
    ];
  });
}

function toPhones(raw: unknown): IdentityPhone[] {
  return componentEntries(raw).flatMap((item) => {
    const number = readText(item.number);
    if (!number) return [];
    return [
      {
        ...(typeof item.id === "number" ? { id: item.id } : {}),
        label: readText(item.label),
        number,
      },
    ];
  });
}

function toContactNumbers(raw: unknown): IdentityContactNumber[] {
  return componentEntries(raw).flatMap((item) => {
    const number = readText(item.number);
    if (!number) return [];
    return [
      {
        ...(typeof item.id === "number" ? { id: item.id } : {}),
        label: readText(item.label),
        number,
        type: isContactNumberType(item.type) ? item.type : undefined,
      },
    ];
  });
}

function toStores(raw: unknown): IdentityStore[] {
  return componentEntries(raw).map((item) => ({
    ...(typeof item.id === "number" ? { id: item.id } : {}),
    name: repairStoreDisplayName(readText(item.name)),
    address: readText(item.address),
    postalCode: readText(item.postalCode),
    phones: toPhones(item.phones),
    wazeLink: readText(item.wazeLink),
    neshanLink: readText(item.neshanLink),
    baladLink: readText(item.baladLink),
    googleMapsLink: readText(item.googleMapsLink),
    showInFooter: item.showInFooter !== false,
    showInAbout: Boolean(item.showInAbout),
    socialLinks: toSocialLinks(item.socialLinks),
  }));
}

export function normalizeSiteIdentity(attributes: unknown): SiteIdentity {
  if (!attributes || typeof attributes !== "object") return DEFAULT_SITE_IDENTITY;
  const source = attributes as Record<string, unknown>;
  return {
    siteName: resolveSiteName(readText(source.siteName)),
    brandDescription: readText(source.brandDescription),
    contactEmail: readText(source.contactEmail),
    supportHours: readText(source.supportHours),
    hasPhysicalStores: source.hasPhysicalStores !== false,
    hasMultipleStores: Boolean(source.hasMultipleStores),
    stores: toStores(source.stores),
    socialLinks: toSocialLinks(source.socialLinks),
    contactNumbers: toContactNumbers(source.contactNumbers),
  };
}

export function readSiteIdentityFromApi(res: unknown): SiteIdentity {
  const fields = unwrapStrapiFields(res);
  return fields ? normalizeSiteIdentity(fields) : DEFAULT_SITE_IDENTITY;
}

export async function getSiteIdentity(): Promise<SiteIdentity> {
  try {
    const baseUrl = typeof window === "undefined" ? getStrapiServerUrl() : API_BASE_URL;
    const response = await fetch(`${baseUrl}/site-identity?${POPULATE_QUERY}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {}),
      },
      next: { tags: [SITE_IDENTITY_TAG], revalidate: 3600 },
    });

    if (response.status === 404) return DEFAULT_SITE_IDENTITY;
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const result: unknown = await response.json();
    return readSiteIdentityFromApi(result);
  } catch (error) {
    console.warn("Site identity unavailable, using defaults:", error);
    return DEFAULT_SITE_IDENTITY;
  }
}
