"use client";

import { useEffect, useState, type ComponentType } from "react";
import HeroStandardSlider from "./HeroStandardSlider";
import HeroStaticFallback from "./HeroStaticFallback";
import { useAdaptiveHydrated, useAdaptiveQuality } from "@/lib/adaptive-quality";
import { scheduleAfterCriticalLoad } from "@/lib/adaptive-quality/after-critical-load";
import type { HeroSlideConfig } from "@/types/super-admin/heroSliderV3";

type HeroBannerSliderProps = {
  slides: HeroSlideConfig[];
  autoplayInterval?: number;
  autoplayEligibility?: boolean[];
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
  const [EnhancedSlider, setEnhancedSlider] = useState<ComponentType<HeroBannerSliderProps> | null>(
    null,
  );

  useEffect(() => {
    if (!enhancedEligible || EnhancedSlider) return;
    let cancelled = false;
    const cancelSchedule = scheduleAfterCriticalLoad(() => {
      import("./HeroEnhancedSlider")
        .then((module) => {
          if (!cancelled) setEnhancedSlider(() => module.default);
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
      cancelSchedule();
    };
  }, [EnhancedSlider, enhancedEligible]);

  if (slides.length === 0) return null;
  if (!hydrated || quality.rendering === "safe" || quality.motion === "minimal") {
    return <HeroStaticFallback slides={slides} />;
  }

  if (enhancedEligible && EnhancedSlider) {
    return (
      <EnhancedSlider
        slides={slides}
        autoplayInterval={autoplayInterval}
        autoplayEligibility={autoplayEligibility}
      />
    );
  }

  if (enhancedEligible) return <HeroStaticFallback slides={slides} />;

  return <HeroStandardSlider slides={slides} />;
}
