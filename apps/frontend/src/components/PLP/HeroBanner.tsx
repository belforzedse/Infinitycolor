"use client";

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { scrollIntoViewWithOffset } from "@/utils/scroll";
import { faNum } from "@/utils/faNum";
import {
  getPlpHeroSwipeDelta,
  PLP_HERO_SLIDES,
  PLP_PRODUCTS_ANCHOR_ID,
  type PlpHeroSlide,
} from "./plpHeroSlides";

interface PLPHeroBannerProps {
  initialTitle?: string;
}

function scrollToPlpProducts() {
  const target =
    document.getElementById(PLP_PRODUCTS_ANCHOR_ID) ??
    document.querySelector<HTMLElement>("[data-plp-top]");
  scrollIntoViewWithOffset(target);
}

function SlideImage({ slide, eager }: { slide: PlpHeroSlide; eager: boolean }) {
  return (
    <picture className="block h-full w-full">
      <source media="(max-width: 767px)" srcSet={slide.mobileSrc} />
      {/* eslint-disable-next-line @next/next/no-img-element -- The PLP hero needs art-directed desktop and mobile bitmap sources. */}
      <img
        src={slide.desktopSrc}
        alt={slide.alt}
        width={1360}
        height={400}
        className="pointer-events-none block h-full w-full max-w-full object-cover"
        decoding="async"
        draggable={false}
        fetchPriority={eager ? "high" : "low"}
        loading={eager ? "eager" : "lazy"}
      />
    </picture>
  );
}

export default function PLPHeroBanner({ initialTitle }: PLPHeroBannerProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const pointerStartXRef = useRef<number | null>(null);
  const didSwipeRef = useRef(false);
  const label = initialTitle ? `بنر ${initialTitle}` : "بنر محصولات";

  const goToSlide = useCallback((index: number) => {
    const total = PLP_HERO_SLIDES.length;
    setActiveIndex(((index % total) + total) % total);
  }, []);

  const handleBannerActivate = useCallback(() => {
    if (didSwipeRef.current) return;
    scrollToPlpProducts();
  }, []);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    pointerStartXRef.current = event.clientX;
    didSwipeRef.current = false;
  }, []);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (pointerStartXRef.current == null) return;
    if (Math.abs(event.clientX - pointerStartXRef.current) > 12) {
      didSwipeRef.current = true;
    }
  }, []);

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (pointerStartXRef.current == null) return;
      const deltaX = event.clientX - pointerStartXRef.current;
      pointerStartXRef.current = null;

      const swipeDelta = getPlpHeroSwipeDelta(deltaX);
      if (swipeDelta === 0) return;

      didSwipeRef.current = true;
      goToSlide(activeIndex + swipeDelta);
    },
    [activeIndex, goToSlide],
  );

  const handleBannerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        didSwipeRef.current = false;
        handleBannerActivate();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToSlide(activeIndex + 1);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        goToSlide(activeIndex - 1);
      }
    },
    [activeIndex, goToSlide, handleBannerActivate],
  );

  return (
    <section className="relative w-full" aria-label={label} aria-roledescription="carousel">
      <div
        role="button"
        tabIndex={0}
        aria-label="مشاهده محصولات"
        className="relative aspect-[414/130] w-full cursor-pointer touch-pan-y overflow-hidden rounded-2xl select-none md:aspect-[1360/400]"
        onClick={handleBannerActivate}
        onKeyDown={handleBannerKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          pointerStartXRef.current = null;
        }}
      >
        <div
          dir="ltr"
          className="flex h-full w-full motion-reduce:transition-none motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out"
          style={{ transform: `translate3d(-${activeIndex * 100}%, 0, 0)` }}
        >
          {PLP_HERO_SLIDES.map((slide, index) => (
            <div
              key={slide.id}
              className="h-full min-w-full max-w-full shrink-0 grow-0 basis-full overflow-hidden"
              aria-hidden={index !== activeIndex}
            >
              <SlideImage slide={slide} eager={index === 0} />
            </div>
          ))}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center md:bottom-3">
        <div className="pointer-events-auto flex items-center gap-0.5" role="tablist" aria-label="اسلایدهای بنر">
          {PLP_HERO_SLIDES.map((slide, index) => {
            const isActive = index === activeIndex;
            return (
              <button
                key={slide.id}
                type="button"
                role="tab"
                aria-label={`اسلاید ${faNum(index + 1)}`}
                aria-selected={isActive}
                className="flex h-5 w-5 items-center justify-center"
                onClick={(event) => {
                  event.stopPropagation();
                  goToSlide(index);
                }}
              >
                <span
                  className={
                    isActive
                      ? "h-1 w-1 rounded-full bg-infinity-primary"
                      : "h-1 w-1 rounded-full bg-infinity-primary/30"
                  }
                />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
