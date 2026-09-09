export type PlpHeroSlide = {
  id: string;
  desktopSrc: string;
  mobileSrc: string;
  alt: string;
};

export const PLP_HERO_SLIDES: readonly PlpHeroSlide[] = [
  {
    id: "special-style",
    desktopSrc: "/images/plp-hero-1-desktop.jpg",
    mobileSrc: "/images/plp-hero-1-mobile.png",
    alt: "استایل خاص منحصر به تو",
  },
  {
    id: "fresh-choices",
    desktopSrc: "/images/plp-hero-2-desktop.jpg",
    mobileSrc: "/images/plp-hero-2-mobile.png",
    alt: "انتخاب‌های تازه، برای استایل تو",
  },
  {
    id: "find-your-style",
    desktopSrc: "/images/plp-hero-3-desktop.jpg",
    mobileSrc: "/images/plp-hero-3-mobile.png",
    alt: "استایل خودت را پیدا کن",
  },
] as const;

export const PLP_PRODUCTS_ANCHOR_ID = "plp-products";
export const PLP_HERO_SWIPE_THRESHOLD_PX = 40;

export function getPlpHeroSwipeDelta(
  deltaX: number,
  threshold = PLP_HERO_SWIPE_THRESHOLD_PX,
): -1 | 0 | 1 {
  if (Math.abs(deltaX) < threshold) return 0;
  return deltaX < 0 ? 1 : -1;
}
