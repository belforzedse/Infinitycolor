import { RETURNS_PATH, RETURNS_TITLE } from "./legal";

export type FooterLink =
  | {
      title: string;
      url: string;
    }
  | {
      title: string;
      action: "open-model-hiring";
    };

export interface FooterColumn {
  header: string;
  links: FooterLink[];
}

export interface ContactInfo {
  phone: string;
  whatsapp: string | null;
  instagram: string | null;
  telegram: string | null;
}

export interface FooterData {
  customerSupport: string;
  first: FooterColumn;
  second: FooterColumn;
  third: FooterColumn;
  contactUs: ContactInfo;
  storeLocations: string;
}

export const FOOTER_DATA: FooterData = {
  customerSupport: "شنبه تا پنج شنبه (غیر از روزهای تعطیل) از ساعت9 صبح الی 17 پاسخگوی شما هستیم.",
  first: {
    header: "حساب کاربری",
    links: [
      { title: "حساب کاربری من", url: "/account" },
      { title: "فروشگاه", url: "/plp" },
      { title: "سبد خرید", url: "/cart" },
      // { title: "ویدیوهای آموزشی", url: "https://new.infinitycolor.co/videos/" },
      { title: "اینفینیتی مگ", url: "https://infinitycolor.co/blog/" },
    ],
  },
  second: {
    header: "دسترسی سریع",
    links: [
      { title: "خرید بافت", url: "/plp/category/پلیور-و-بافت" },
      { title: "خرید پیراهن زنانه", url: "/plp/category/shirt" },
      {
        title: "خرید شال و روسری",
        url: "/plp/category/shawls-and-scarves",
      },
      {
        title: "خرید شومیز",
        url: "/plp/category/paperback-and-tonic",
      },
      {
        title: "خرید مانتو",
        url: "/plp/category/coat-and-mantle",
      },
    ],
  },
  third: {
    header: "خدمات مشتریان",
    links: [
      { title: "درباره ما", url: "/about" },
      { title: "تماس با ما", url: "/contact" },
      { title: "سوالات متداول", url: "/faq" },
      { title: RETURNS_TITLE, url: RETURNS_PATH },
      { title: "درخواست همکاری", action: "open-model-hiring" },
    ],
  },
  contactUs: {
    phone: "017-325-304-39",
    whatsapp: "0901-655-25-30",
    instagram: "infinity.color_boutique",
    telegram: "InfinityColorShop",
  },
  storeLocations: "گرگان، بلوار ناهارخوران نبش عدالت 68، گنبد کاووس، ابتدای بلوار دانشجو",
};

/**
 * eNamad trust seal. The badge must be hot-linked from `trustseal.enamad.ir`
 * and wrapped in a link back to the verification page — eNamad validates the
 * referring domain, so a re-hosted or proxied copy fails the check.
 */
export const ENAMAD_SEAL = {
  id: "161544",
  code: "ubfacOD0MKGTamyXgVNX",
} as const;

export const ENAMAD_SEAL_IMAGE_URL = `https://trustseal.enamad.ir/logo.aspx?id=${ENAMAD_SEAL.id}&Code=${ENAMAD_SEAL.code}`;
export const ENAMAD_SEAL_VERIFY_URL = `https://trustseal.enamad.ir/?id=${ENAMAD_SEAL.id}&Code=${ENAMAD_SEAL.code}`;
