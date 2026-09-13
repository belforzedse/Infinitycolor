"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import HeroBannerPagination from "./HeroBannerPagination";
import ResponsiveHeroImage from "./ResponsiveHeroImage";
import { useAutoplaySlider } from "./useAutoplaySlider";
import type { HeroSlideConfig } from "@/types/super-admin/heroSliderV3";

/**
 * The hero every device gets unless it qualifies for the Enhanced build.
 *
 * Autoplay used to live only in HeroEnhancedSlider, so any device the adaptive
 * policy downgraded — low-end, save-data, reduced-motion, slow network — saw a
 * hero that never advanced no matter what interval the CMS held. The rotation is
 * content, not decoration, so it belongs at every tier; what stays Enhanced-only
 * is the framer crossfade. This implementation still swaps the slide instantly.
 *
 * Every manual control goes through the hook's `goTo`/`next`/`prev` rather than
 * writing the index directly, because those bump the hook's play key and so
 * restart the interval. Calling `onActiveIndexChange` here instead would leave
 * the running timer untouched and fire its own advance moments after a click.
 */
export default function HeroStandardSlider({
  slides,
  autoplayInterval,
  autoplayEligibility,
  activeIndex,
  onActiveIndexChange,
}: {
  slides: HeroSlideConfig[];
  autoplayInterval?: number;
  autoplayEligibility?: boolean[];
  activeIndex: number;
  onActiveIndexChange: Dispatch<SetStateAction<number>>;
}) {
  const { index: hookIndex, goTo, next, prev } = useAutoplaySlider({
    slidesLength: slides.length,
    autoplayInterval,
    autoplayEligibility,
    controlledIndex: activeIndex,
    onIndexChange: onActiveIndexChange,
  });

  const index = Math.min(hookIndex, Math.max(0, slides.length - 1));
  const activeSlide = slides[index] || slides[0];
  const goToSlide = useCallback((target: number) => goTo(target), [goTo]);

  if (!activeSlide) return null;
  const hasMultipleSlides = slides.length > 1;

  return (
    <div
      className="relative mx-auto w-full lg:overflow-hidden lg:rounded-[34px]"
      data-aq-hero="standard"
    >
      <div
        className="relative aspect-[361/387] w-full overflow-hidden rounded-[18px] bg-[#f9f1ee] lg:aspect-[1360/581] lg:rounded-[inherit]"
        data-hero-banner=""
      >
        <ResponsiveHeroImage slide={activeSlide} eager={index === 0} />
      </div>

      {hasMultipleSlides ? (
        <HeroBannerPagination
          total={slides.length}
          index={index}
          onDotClick={goToSlide}
          onNext={next}
          onPrev={prev}
          className="pointer-events-auto bg-white/90 shadow-sm"
        />
      ) : null}
    </div>
  );
}
