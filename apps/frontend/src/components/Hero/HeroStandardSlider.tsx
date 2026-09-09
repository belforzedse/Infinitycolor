"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import HeroBannerPagination from "./HeroBannerPagination";
import ResponsiveHeroImage from "./ResponsiveHeroImage";
import type { HeroSlideConfig } from "@/types/super-admin/heroSliderV3";

export default function HeroStandardSlider({
  slides,
  activeIndex,
  onActiveIndexChange,
}: {
  slides: HeroSlideConfig[];
  activeIndex: number;
  onActiveIndexChange: Dispatch<SetStateAction<number>>;
}) {
  const index = Math.min(activeIndex, Math.max(0, slides.length - 1));
  const activeSlide = slides[index] || slides[0];
  const next = useCallback(() => {
    onActiveIndexChange((current) => (current + 1) % slides.length);
  }, [onActiveIndexChange, slides.length]);
  const previous = useCallback(() => {
    onActiveIndexChange((current) => (current - 1 + slides.length) % slides.length);
  }, [onActiveIndexChange, slides.length]);

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
          onDotClick={onActiveIndexChange}
          onNext={next}
          onPrev={previous}
          className="pointer-events-auto bg-white/90 shadow-sm"
        />
      ) : null}
    </div>
  );
}
