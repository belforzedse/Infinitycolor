import { apiClient } from "@/services";
import type {
  IdentityContactNumber,
  IdentityPhone,
  IdentitySocialLink,
  IdentityStore,
  SiteIdentity,
} from "@/types/site-identity";
import { DEFAULT_SITE_IDENTITY, SITE_IDENTITY_POPULATE } from "@/services/site-identity";
import { getSuperAdminSiteIdentity } from "./get";

export const SOCIAL_LINK_URL_REQUIRED_MESSAGE =
  "آدرس شبکه اجتماعی را وارد کنید و دوباره تلاش کنید.";

function clean<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(obj)) {
    (out as Record<string, unknown>)[k] = v === "" ? null : v;
  }
  return out;
}

function withOptionalId<T extends Record<string, unknown>>(
  id: number | undefined,
  fields: T,
): T & { id?: number } {
  if (typeof id === "number" && Number.isInteger(id) && id > 0) {
    return { ...fields, id };
  }
  return fields;
}

function isBlankSocial(link: IdentitySocialLink): boolean {
  return !link.url?.trim() && !link.label?.trim() && (!link.platform || link.platform === "instagram");
}

function socialLinksForWrite(links: IdentitySocialLink[] | undefined): Record<string, unknown>[] {
  const items = links ?? [];
  if (items.some((link) => !isBlankSocial(link) && !link.url?.trim())) {
    throw new Error(SOCIAL_LINK_URL_REQUIRED_MESSAGE);
  }
  return items.filter((link) => Boolean(link.url?.trim())).map((link) =>
    clean(
      withOptionalId(link.id, {
        platform: link.platform,
        url: link.url.trim(),
        label: link.label?.trim() || null,
      }),
    ),
  );
}

function phonesForWrite(phones: IdentityPhone[] | undefined): Record<string, unknown>[] {
  return (phones ?? [])
    .filter((phone) => phone.number?.trim())
    .map((phone) =>
      clean(
        withOptionalId(phone.id, {
          label: phone.label?.trim() || null,
          number: phone.number.trim(),
        }),
      ),
    );
}

function contactNumbersForWrite(
  contacts: IdentityContactNumber[] | undefined,
): Record<string, unknown>[] {
  return (contacts ?? [])
    .filter((contact) => contact.number?.trim())
    .map((contact) =>
      clean(
        withOptionalId(contact.id, {
          label: contact.label?.trim() || null,
          number: contact.number.trim(),
          type: contact.type ?? null,
        }),
      ),
    );
}

function storeForWrite(store: IdentityStore): Record<string, unknown> {
  return clean(
    withOptionalId(store.id, {
      name: store.name ?? null,
      address: store.address ?? null,
      postalCode: store.postalCode ?? null,
      phones: phonesForWrite(store.phones),
      wazeLink: store.wazeLink ?? null,
      neshanLink: store.neshanLink ?? null,
      baladLink: store.baladLink ?? null,
      googleMapsLink: store.googleMapsLink ?? null,
      showInFooter: Boolean(store.showInFooter),
      showInAbout: Boolean(store.showInAbout),
      socialLinks: socialLinksForWrite(store.socialLinks),
    }),
  );
}

export function buildSiteIdentityWritePayload(identity: SiteIdentity): Record<string, unknown> {
  return {
    siteName: identity.siteName?.trim() || DEFAULT_SITE_IDENTITY.siteName,
    brandDescription: identity.brandDescription?.trim() || null,
    contactEmail: identity.contactEmail?.trim() || null,
    supportHours: identity.supportHours?.trim() || null,
    hasPhysicalStores: Boolean(identity.hasPhysicalStores),
    hasMultipleStores: Boolean(identity.hasMultipleStores),
    stores: (identity.stores ?? []).map(storeForWrite),
    socialLinks: socialLinksForWrite(identity.socialLinks),
    contactNumbers: contactNumbersForWrite(identity.contactNumbers),
  };
}

export async function updateSuperAdminSiteIdentity(identity: SiteIdentity): Promise<SiteIdentity> {
  const data = buildSiteIdentityWritePayload(identity);
  await apiClient.put(`/site-identity?${SITE_IDENTITY_POPULATE}`, { data });
  return getSuperAdminSiteIdentity();
}
