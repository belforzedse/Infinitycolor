export type PlpHeroSlide = {
  id: string;
  desktopSrc: string;
  mobileSrc: string;
  alt: string;
};

export const PLP_HERO_SLIDES: readonly PlpHeroSlide[] = [
  {
    id: "special-style",
    desktopSrc: "/images/plp-hero-1-desktop.webp",
    mobileSrc: "/images/plp-hero-1-mobile.png",
    alt: "استایل خاص منحصر به تو",
  },
  {
    id: "fresh-choices",
    desktopSrc: "/images/plp-hero-2-desktop.webp",
    mobileSrc: "/images/plp-hero-2-mobile.png",
    alt: "انتخاب‌های تازه، برای استایل تو",
  },
  {
    id: "find-your-style",
    desktopSrc: "/images/plp-hero-3-desktop.webp",
    mobileSrc: "/images/plp-hero-3-mobile.png",
    alt: "استایل خودت را پیدا کن",
  },
] as const;

export const PLP_PRODUCTS_ANCHOR_ID = "plp-products";
export const PLP_HERO_SWIPE_THRESHOLD_PX = 40;
export const PLP_HERO_SWIPE_AXIS_LOCK_PX = 8;
export const PLP_HERO_SWIPE_FLICK_VELOCITY = 0.45;

export function getPlpHeroSwipeDelta(
  deltaX: number,
  threshold = PLP_HERO_SWIPE_THRESHOLD_PX,
  velocityPxPerMs = 0,
): -1 | 0 | 1 {
  if (Math.abs(deltaX) >= threshold) return deltaX < 0 ? 1 : -1;
  if (
    Math.abs(velocityPxPerMs) >= PLP_HERO_SWIPE_FLICK_VELOCITY &&
    Math.abs(deltaX) >= PLP_HERO_SWIPE_AXIS_LOCK_PX
  ) {
    return deltaX < 0 ? 1 : -1;
  }
  return 0;
}

export function clampPlpHeroIndex(index: number, total = PLP_HERO_SLIDES.length): number {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, index));
}
