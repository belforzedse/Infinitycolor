"use client";

import SiteGifBanner, { type SiteGifBannerProps } from "./SiteGifBanner";
import { noteEnhancementLoaded } from "@/lib/adaptive-quality";
import { useEffect } from "react";

export default function AdaptiveSiteGifBanner(props: SiteGifBannerProps) {
  const hasAnimatedGif = props.enabled && Boolean(props.imageUrl?.trim());

  useEffect(() => {
    if (hasAnimatedGif) noteEnhancementLoaded("optional-gif");
  }, [hasAnimatedGif]);

  return <SiteGifBanner {...props} />;
}
