import { createElement } from "react";
import type { ComponentType } from "react";
import { MessageCircle } from "lucide-react";
import {
  SiAparat,
  SiInstagram,
  SiLinkedin,
  SiTelegram,
  SiWhatsapp,
  SiX,
  SiYoutube,
} from "react-icons/si";
import type { ContactNumberType, IdentityStore, SocialPlatform } from "@/types/site-identity";

type SocialIconComponent = ComponentType<{
  "aria-hidden"?: boolean;
  className?: string;
  color?: string;
  focusable?: boolean;
  size?: number;
}>;

export type SocialPlatformMeta = {
  value: SocialPlatform;
  label: string;
  adminLabel?: string;
  Icon?: SocialIconComponent;
  iconSrc?: string;
  color: string;
  hasPlaceholderIcon?: boolean;
};

const GenericSocialIcon = MessageCircle as SocialIconComponent;

/** Official Bale check-in-circle from https://bale.ai/logo/bale_logo.svg */
export const BALE_ICON_PATH =
  "M16 0C7.163 0 0 7.163 0 16s7.163 16 16 16 16-7.163 16-16S24.837 0 16 0zm9.34 13.953L16.05 23.243a3.12 3.12 0 0 1-4.416 0l-4.974-4.974a3.12 3.12 0 0 1 4.415 0l2.767 2.766 7.083-7.083a3.12 3.12 0 0 1 4.415 4.415z";

const BaleIcon: SocialIconComponent = ({
  "aria-hidden": ariaHidden,
  className,
  color,
  focusable,
  size = 16,
}) =>
  createElement(
    "svg",
    {
      "aria-hidden": ariaHidden,
      className,
      color,
      fill: "none",
      focusable,
      height: size,
      viewBox: "0 0 32 32",
      width: size,
      xmlns: "http://www.w3.org/2000/svg",
    },
    createElement("path", {
      clipRule: "evenodd",
      d: BALE_ICON_PATH,
      fill: "currentColor",
      fillRule: "evenodd",
    }),
  );

export const SOCIAL_PLATFORM_META: Record<SocialPlatform, SocialPlatformMeta> = {
  instagram: {
    value: "instagram",
    label: "اینستاگرام",
    Icon: SiInstagram,
    color: "#E4405F",
  },
  telegram: {
    value: "telegram",
    label: "تلگرام",
    Icon: SiTelegram,
    color: "#26A5E4",
  },
  whatsapp: {
    value: "whatsapp",
    label: "واتساپ",
    Icon: SiWhatsapp,
    color: "#25D366",
  },
  bale: {
    value: "bale",
    label: "بله",
    Icon: BaleIcon,
    iconSrc: "/images/social/bale.svg",
    color: "#00B894",
  },
  x: {
    value: "x",
    label: "ایکس",
    adminLabel: "ایکس (توییتر)",
    Icon: SiX,
    color: "#000000",
  },
  linkedin: {
    value: "linkedin",
    label: "لینکدین",
    Icon: SiLinkedin,
    color: "#0A66C2",
  },
  youtube: {
    value: "youtube",
    label: "یوتیوب",
    Icon: SiYoutube,
    color: "#FF0000",
  },
  aparat: {
    value: "aparat",
    label: "آپارات",
    Icon: SiAparat,
    color: "#ED145B",
  },
  eitaa: {
    value: "eitaa",
    label: "ایتا",
    // No brand asset ships for this platform: /images/social/eitaa.svg was
    // referenced but has never existed in public/, so the raw <img> below
    // rendered as a broken icon. Fall back to the generic mark until a real
    // logo is supplied, then restore `iconSrc`.
    Icon: GenericSocialIcon,
    hasPlaceholderIcon: true,
    color: "#E37600",
  },
  rubika: {
    value: "rubika",
    label: "روبیکا",
    // No brand asset ships for this platform: /images/social/rubika.png was
    // referenced but has never existed in public/, so the raw <img> below
    // rendered as a broken icon. Fall back to the generic mark until a real
    // logo is supplied, then restore `iconSrc`.
    Icon: GenericSocialIcon,
    hasPlaceholderIcon: true,
    color: "#7D4593",
  },
  other: {
    value: "other",
    label: "شبکه اجتماعی",
    adminLabel: "سایر",
    Icon: GenericSocialIcon,
    color: "#6B7280",
    hasPlaceholderIcon: true,
  },
};

export const SOCIAL_PLATFORM_OPTIONS = Object.values(SOCIAL_PLATFORM_META).map((platform) => ({
  value: platform.value,
  label: platform.adminLabel ?? platform.label,
}));

/** Map link icons available under /public/images/social. */
export function storeMapLinks(store: IdentityStore): { src: string; alt: string; href: string }[] {
  const links: { src: string; alt: string; href: string }[] = [];
  if (store.baladLink)
    links.push({ src: "/images/social/balad.png", alt: "بلد", href: store.baladLink });
  if (store.googleMapsLink)
    links.push({ src: "/images/social/g-map.png", alt: "گوگل مپ", href: store.googleMapsLink });
  if (store.neshanLink)
    links.push({ src: "/images/social/neshan.png", alt: "نشان", href: store.neshanLink });
  if (store.wazeLink)
    links.push({ src: "/images/social/waze.png", alt: "ویز", href: store.wazeLink });
  return links;
}

export function getSocialPlatformMeta(platform: SocialPlatform): SocialPlatformMeta {
  return SOCIAL_PLATFORM_META[platform] ?? SOCIAL_PLATFORM_META.other;
}

export function SocialPlatformIcon({
  platform,
  size = 16,
  className,
}: {
  platform: SocialPlatform;
  size?: number;
  className?: string;
}) {
  const { Icon, color, iconSrc, label } = getSocialPlatformMeta(platform);
  const iconClassName = `shrink-0 ${className ?? ""}`.trim();

  if (Icon) {
    return createElement(Icon, {
      "aria-hidden": true,
      className: iconClassName,
      color,
      focusable: false,
      size,
    });
  }

  if (iconSrc) {
    return createElement("img", {
      "aria-hidden": true,
      alt: "",
      className: iconClassName,
      height: size,
      src: iconSrc,
      title: label,
      width: size,
    });
  }

  return null;
}

export function contactIcon(type?: ContactNumberType): string {
  return type === "whatsapp" ? "/images/social/whatsapp.png" : "/images/social/phone.png";
}

const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;

/** CMS numbers arrive with Persian digits, spaces and dashes; hrefs need plain digits. */
function toLatinDigits(value: string): string {
  return value.replace(/[\u06f0-\u06f9\u0660-\u0669]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code >= PERSIAN_ZERO ? PERSIAN_ZERO : ARABIC_ZERO;
    return String(code - base);
  });
}

/**
 * Normalises a displayed contact number to E.164 digits (Iran, country code 98).
 * Returns null when nothing dialable remains, so callers can fall back to plain
 * text rather than emitting a broken link.
 */
export function normalizeContactDigits(raw: string): string | null {
  if (!raw) return null;
  const latin = toLatinDigits(raw).trim();
  const hadPlus = latin.startsWith("+");
  let digits = latin.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("00")) digits = digits.slice(2);
  if (hadPlus && !digits.startsWith("98")) return null;
  if (digits.startsWith("0")) digits = `98${digits.slice(1)}`;
  else if (!digits.startsWith("98")) digits = `98${digits}`;

  // Iranian E.164 numbers are exactly country code 98 plus ten digits. Reject
  // arbitrary long strings instead of turning them into misleading dial links.
  return /^98\d{10}$/.test(digits) ? digits : null;
}

/**
 * Phone and WhatsApp details were rendered as plain text, so a shopper on a
 * phone could not tap to call or open a chat. Build the real target instead.
 */
export function contactHref(contact: { number: string; type?: ContactNumberType }): string | null {
  const digits = normalizeContactDigits(contact.number);
  if (!digits) return null;
  return contact.type === "whatsapp" ? `https://wa.me/${digits}` : `tel:+${digits}`;
}

export function platformLabel(platform: SocialPlatform): string {
  return getSocialPlatformMeta(platform).label;
}
