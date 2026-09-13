"use client";

import { useEffect, useState, type ComponentType, type Dispatch, type SetStateAction } from "react";
import HeroStandardSlider from "./HeroStandardSlider";
import HeroStaticFallback from "./HeroStaticFallback";
import { useAdaptiveHydrated, useAdaptiveQuality } from "@/lib/adaptive-quality";
import type { HeroSlideConfig } from "@/types/super-admin/heroSliderV3";

type HeroBannerSliderProps = {
  slides: HeroSlideConfig[];
  autoplayInterval?: number;
  autoplayEligibility?: boolean[];
};

export type HeroSliderImplementationProps = HeroBannerSliderProps & {
  activeIndex: number;
  onActiveIndexChange: Dispatch<SetStateAction<number>>;
};

export default function HeroBannerSlider({
  slides,
  autoplayInterval,
  autoplayEligibility,
}: HeroBannerSliderProps) {
  const hydrated = useAdaptiveHydrated();
  const quality = useAdaptiveQuality();
  const enhancedEligible =
    hydrated && quality.rendering === "enhanced" && quality.motion === "enhanced";
  const [activeIndex, setActiveIndex] = useState(0);
  const [EnhancedSlider, setEnhancedSlider] =
    useState<ComponentType<HeroSliderImplementationProps> | null>(null);

  useEffect(() => {
    if (!enhancedEligible || EnhancedSlider) return;
    let cancelled = false;
    import("./HeroEnhancedSlider")
      .then((module) => {
        if (!cancelled) setEnhancedSlider(() => module.default);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [EnhancedSlider, enhancedEligible]);

  if (slides.length === 0) return null;
  if (!hydrated) {
    return <HeroStaticFallback slides={slides} />;
  }

  if (enhancedEligible && EnhancedSlider) {
    return (
      <EnhancedSlider
        slides={slides}
        autoplayInterval={autoplayInterval}
        autoplayEligibility={autoplayEligibility}
        activeIndex={activeIndex}
        onActiveIndexChange={setActiveIndex}
      />
    );
  }

  return (
    <HeroStandardSlider
      slides={slides}
      autoplayInterval={autoplayInterval}
      autoplayEligibility={autoplayEligibility}
      activeIndex={activeIndex}
      onActiveIndexChange={setActiveIndex}
    />
  );
}
