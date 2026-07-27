"use client";

import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  m,
  type PanInfo,
} from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import PaginationDesktop from "./PaginationDesktop";
import ResponsiveHeroImage from "./ResponsiveHeroImage";
import { useAutoplaySlider } from "./useAutoplaySlider";
import { noteEnhancementLoaded } from "@/lib/adaptive-quality";
import type { HeroSlideConfig } from "@/types/super-admin/heroSliderV3";

const loadMotionFeatures = () =>
  import("./motion-features").then((module) => module.default);
const SLIDE_SWIPE_THRESHOLD = 56;
const SLIDE_SWIPE_VELOCITY = 420;

type Props = {
  slides: HeroSlideConfig[];
  autoplayInterval?: number;
  autoplayEligibility?: boolean[];
};

export default function HeroEnhancedSlider({
  slides,
  autoplayInterval,
  autoplayEligibility,
}: Props) {
  const [slideDirection, setSlideDirection] = useState(1);
  const { index, goTo, next, prev } = useAutoplaySlider({
    slidesLength: slides.length,
    autoplayInterval,
    autoplayEligibility,
  });
  const hasMultipleSlides = slides.length > 1;
  const activeSlide = slides[index] || slides[0];

  useEffect(() => {
    noteEnhancementLoaded("hero-motion");
  }, []);

  const goToSlide = useCallback(
    (targetIndex: number) => {
      setSlideDirection(targetIndex > index ? 1 : -1);
      goTo(targetIndex);
    },
    [goTo, index],
  );
  const goNext = useCallback(() => {
    setSlideDirection(1);
    next();
  }, [next]);
  const goPrevious = useCallback(() => {
    setSlideDirection(-1);
    prev();
  }, [prev]);
  const handleDragEnd = useCallback(
    (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (!hasMultipleSlides) return;
      const shouldSwipe =
        Math.abs(info.offset.x) > SLIDE_SWIPE_THRESHOLD ||
        Math.abs(info.velocity.x) > SLIDE_SWIPE_VELOCITY;
      if (!shouldSwipe) return;
      if (info.offset.x < 0) goNext();
      else goPrevious();
    },
    [goNext, goPrevious, hasMultipleSlides],
  );

  if (!activeSlide) return null;

  const variants = {
    enter: (direction: number) => ({
      opacity: 0,
      x: direction > 0 ? "7%" : "-7%",
      scale: 1.01,
    }),
    center: { opacity: 1, x: 0, scale: 1 },
    exit: (direction: number) => ({
      opacity: 0,
      x: direction > 0 ? "-7%" : "7%",
      scale: 1.005,
    }),
  };

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={loadMotionFeatures} strict>
        <div
          className="relative mx-auto w-full overflow-hidden rounded-[18px] lg:rounded-[34px]"
          data-aq-hero="enhanced"
          data-adaptive-decorative="rich"
        >
          <m.div
            className="relative aspect-[361/387] w-full touch-pan-y overflow-hidden rounded-[inherit] bg-[#f9f1ee] lg:aspect-[1360/581]"
            drag={hasMultipleSlides ? "x" : false}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.12}
            onDragEnd={handleDragEnd}
          >
            <AnimatePresence initial={false} custom={slideDirection} mode="popLayout">
              <m.div
                key={activeSlide.id}
                className="absolute inset-0"
                custom={slideDirection}
                variants={variants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
              >
                <ResponsiveHeroImage slide={activeSlide} eager={index === 0} />
              </m.div>
            </AnimatePresence>
          </m.div>

          {hasMultipleSlides ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center sm:bottom-3 lg:bottom-4">
              <PaginationDesktop
                total={slides.length}
                index={index}
                onDotClick={goToSlide}
                onNext={goNext}
                onPrev={goPrevious}
                className="pointer-events-auto bg-white/45 shadow-sm backdrop-blur-md"
                arrowClassName="text-[#623E29]"
                dotClassName="bg-[#623E29]/25"
                dotActiveClassName="bg-[#623E29]/70"
              />
            </div>
          ) : null}
        </div>
      </LazyMotion>
    </MotionConfig>
  );
}

