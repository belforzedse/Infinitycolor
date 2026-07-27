"use client";

import Link from "next/link";
import SiteGifBanner, { type SiteGifBannerProps } from "./SiteGifBanner";
import {
  noteEnhancementLoaded,
  useAdaptiveHydrated,
  useAdaptiveQuality,
} from "@/lib/adaptive-quality";
import {
  SITE_GIF_ASPECT_CLASS,
  SITE_GIF_DESKTOP_HEIGHT,
  SITE_GIF_DESKTOP_WIDTH,
} from "@/constants/site-gif";
import { cn } from "@/lib/utils";
import { useEffect } from "react";

function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export default function AdaptiveSiteGifBanner(props: SiteGifBannerProps) {
  const hydrated = useAdaptiveHydrated();
  const quality = useAdaptiveQuality();
  const showAnimated = hydrated && quality.media !== "economy";

  useEffect(() => {
    if (showAnimated) noteEnhancementLoaded("optional-gif");
  }, [showAnimated]);

  if (!props.enabled || !props.imageUrl?.trim()) return null;
  if (showAnimated) return <SiteGifBanner {...props} />;

  const label = props.altText?.trim() || "پیشنهاد ویژه اینفینیتی";
  const href = props.linkHref?.trim();
  const shell = (
    <div
      role="img"
      aria-label={label}
      className="flex h-full w-full items-center justify-center bg-gradient-to-l from-slate-100 to-stone-50 px-4 text-center text-sm font-medium text-slate-600"
    >
      {label}
    </div>
  );
  const content = href ? (
    isExternalHref(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block h-full w-full"
      >
        {shell}
      </a>
    ) : (
      <Link href={href} className="block h-full w-full">
        {shell}
      </Link>
    )
  ) : (
    shell
  );

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-xl",
        SITE_GIF_ASPECT_CLASS,
        props.className,
      )}
      style={{
        maxWidth:
          props.previewMode === "mobile" ? "390px" : undefined,
      }}
      data-aq-optional-media="gif-shell"
    >
      <span className="sr-only">
        {SITE_GIF_DESKTOP_WIDTH} × {SITE_GIF_DESKTOP_HEIGHT}
      </span>
      {content}
    </div>
  );
}

