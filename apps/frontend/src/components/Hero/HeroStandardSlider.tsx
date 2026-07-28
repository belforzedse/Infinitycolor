"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import PaginationDesktop from "./PaginationDesktop";
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
      className="relative mx-auto w-full overflow-hidden rounded-[18px] lg:rounded-[34px]"
      data-aq-hero="standard"
    >
      <div className="relative aspect-[361/387] w-full overflow-hidden rounded-[inherit] bg-[#f9f1ee] lg:aspect-[1360/581]">
        <ResponsiveHeroImage slide={activeSlide} eager={index === 0} />
      </div>

      {hasMultipleSlides ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center sm:bottom-3 lg:bottom-4">
          <PaginationDesktop
            total={slides.length}
            index={index}
            onDotClick={onActiveIndexChange}
            onNext={next}
            onPrev={previous}
            className="pointer-events-auto bg-white/90 shadow-sm"
            arrowClassName="text-[#623E29]"
            dotClassName="bg-[#623E29]/25"
            dotActiveClassName="bg-[#623E29]/70"
          />
        </div>
      ) : null}
    </div>
  );
}
