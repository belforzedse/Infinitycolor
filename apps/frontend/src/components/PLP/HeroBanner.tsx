"use client";

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { scrollIntoViewWithOffset } from "@/utils/scroll";
import { faNum } from "@/utils/faNum";
import {
  clampPlpHeroIndex,
  getPlpHeroSwipeDelta,
  PLP_HERO_SLIDES,
  PLP_HERO_SWIPE_AXIS_LOCK_PX,
  PLP_HERO_SWIPE_THRESHOLD_PX,
  PLP_PRODUCTS_ANCHOR_ID,
  type PlpHeroSlide,
} from "./plpHeroSlides";

interface PLPHeroBannerProps {
  initialTitle?: string;
}

type DragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastTime: number;
  velocity: number;
  axis: "x" | "y" | null;
  width: number;
};

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
        width={5439}
        height={1583}
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
  const [dragOffsetPx, setDragOffsetPx] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const sessionRef = useRef<DragSession | null>(null);
  const didSwipeRef = useRef(false);
  const activeIndexRef = useRef(0);
  activeIndexRef.current = activeIndex;
  const lastSlideIndex = PLP_HERO_SLIDES.length - 1;
  const label = initialTitle ? `بنر ${initialTitle}` : "بنر محصولات";

  const goToSlide = useCallback((index: number) => {
    const total = PLP_HERO_SLIDES.length;
    setActiveIndex(((index % total) + total) % total);
  }, []);

  const resetDrag = useCallback(() => {
    sessionRef.current = null;
    setIsDragging(false);
    setDragOffsetPx(0);
  }, []);

  const handleBannerActivate = useCallback(() => {
    if (didSwipeRef.current) return;
    scrollToPlpProducts();
  }, []);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button > 0) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    sessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
      axis: null,
      width: event.currentTarget.offsetWidth || 1,
    };
    didSwipeRef.current = false;
  }, []);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    if (!session) return;
    if (
      Number.isFinite(event.pointerId) &&
      Number.isFinite(session.pointerId) &&
      event.pointerId !== session.pointerId
    ) {
      return;
    }

    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;

    if (session.axis == null) {
      if (Math.hypot(dx, dy) < PLP_HERO_SWIPE_AXIS_LOCK_PX) return;
      session.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (session.axis === "x") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // jsdom and some browsers reject capture when the pointer is already released.
        }
        didSwipeRef.current = true;
        setIsDragging(true);
      }
    }

    if (session.axis !== "x") return;
    if (event.cancelable) event.preventDefault();

    const elapsed = event.timeStamp - session.lastTime;
    if (elapsed > 0) {
      session.velocity = (event.clientX - session.lastX) / elapsed;
    }
    session.lastX = event.clientX;
    session.lastTime = event.timeStamp;

    const index = activeIndexRef.current;
    const atStart = index === 0 && dx > 0;
    const atEnd = index === lastSlideIndex && dx < 0;
    setDragOffsetPx(atStart || atEnd ? dx * 0.35 : dx);
  }, [lastSlideIndex]);

  const settleDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const session = sessionRef.current;
      if (!session) return;
      if (
        Number.isFinite(event.pointerId) &&
        Number.isFinite(session.pointerId) &&
        event.pointerId !== session.pointerId
      ) {
        return;
      }

      const dx = event.clientX - session.startX;
      const swipeDelta =
        session.axis === "x"
          ? getPlpHeroSwipeDelta(
              dx,
              Math.max(PLP_HERO_SWIPE_THRESHOLD_PX, session.width * 0.18),
              session.velocity,
            )
          : 0;

      if (swipeDelta !== 0) {
        didSwipeRef.current = true;
        const nextIndex = clampPlpHeroIndex(activeIndexRef.current + swipeDelta);
        setActiveIndex(nextIndex);
      }

      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // Capture may already have been released by the browser.
        }
      }
      resetDrag();
    },
    [resetDrag],
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

  const dragWidth = sessionRef.current?.width || 1;
  const trackOffsetPercent = -activeIndex * 100 + (dragOffsetPx / dragWidth) * 100;

  return (
    <section className="relative w-full" aria-label={label} aria-roledescription="carousel">
      <div
        role="button"
        tabIndex={0}
        aria-label="مشاهده محصولات"
        className="relative aspect-[414/130] w-full cursor-pointer overflow-hidden rounded-2xl select-none md:aspect-[1360/400]"
        style={{ touchAction: isDragging ? "none" : "pan-y" }}
        onClick={handleBannerActivate}
        onKeyDown={handleBannerKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={settleDrag}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch {
              // Capture may already have been released by the browser.
            }
          }
          resetDrag();
        }}
      >
        <div
          dir="ltr"
          className={
            isDragging
              ? "flex h-full w-full transition-none"
              : "flex h-full w-full motion-reduce:transition-none motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out"
          }
          style={{ transform: `translate3d(${trackOffsetPercent}%, 0, 0)` }}
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
