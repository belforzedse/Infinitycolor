"use client";

import React from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft } from "lucide-react";

interface BlogCategoryBannerProps {
  title?: string;
  subtitle?: string;
  backgroundImage?: string;
  /** Intrinsic size of `backgroundImage`, when the CMS reported it. */
  imageWidth?: number;
  imageHeight?: number;
  href: string;
  linkText?: string;
  ariaLabel?: string;
  textColor?: string;
  linkColor?: string;
  subtitleColor?: string;
  height?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * The banner is one shape at every width, so a phone gets the desktop banner
 * scaled down rather than a different crop of the same artwork.
 *
 * It used to be sized in fixed pixels (`h-[300px] md:h-[490px]`), which with
 * `object-cover` made the box roughly 1.2:1 on a phone and 2.5:1 on a desktop —
 * the same image framed two completely different ways. A ratio box keeps the
 * framing identical and lets the whole image fit.
 *
 * These are only fallbacks: when the CMS reports the upload's dimensions the
 * banner uses the image's own ratio instead.
 */
const fallbackAspectRatio = {
  sm: "16 / 5",
  md: "16 / 7",
  lg: "16 / 9",
} as const;

const visibleText = (value?: string) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
};

const BlogCategoryBanner: React.FC<BlogCategoryBannerProps> = ({
  title,
  subtitle,
  backgroundImage,
  imageWidth,
  imageHeight,
  href,
  linkText,
  ariaLabel,
  textColor,
  linkColor,
  subtitleColor,
  height = "lg",
  className = "",
}) => {
  const resolvedTitle = visibleText(title);
  const resolvedSubtitle = visibleText(subtitle);
  const resolvedLinkText = visibleText(linkText);
  const resolvedImage = visibleText(backgroundImage);
  const hasText = Boolean(resolvedTitle || resolvedSubtitle || resolvedLinkText);

  if (!resolvedImage && !hasText) {
    return null;
  }

  const resolvedTitleColor = visibleText(textColor) || "#262626";
  const resolvedSubtitleColor = visibleText(subtitleColor) || "#525252";
  const resolvedLinkColor = visibleText(linkColor) || "#262626";
  const accessibleName =
    resolvedTitle ||
    resolvedLinkText ||
    resolvedSubtitle ||
    visibleText(ariaLabel) ||
    "مشاهده دسته بندی";

  // The image's own ratio when we know it, so nothing is cropped away.
  const aspectRatio =
    imageWidth && imageHeight && imageWidth > 0 && imageHeight > 0
      ? `${imageWidth} / ${imageHeight}`
      : fallbackAspectRatio[height];

  return (
    <Link
      href={href}
      aria-label={accessibleName}
      className={`relative block w-full overflow-hidden rounded-2xl ${className}`}
      style={{ aspectRatio }}
    >
      {resolvedImage && (
        <Image
          src={resolvedImage}
          alt=""
          fill
          unoptimized
          sizes="100vw"
          className="object-cover"
        />
      )}

      {hasText && <div className="absolute inset-0 bg-black/10" />}

      {hasText && (
        <div className="relative z-10 flex h-full flex-col items-start justify-center px-6 text-right md:px-24">
          {resolvedTitle && (
            <h2
              className="mb-3 leading-snug"
              style={{
                color: resolvedTitleColor,
                fontSize: "clamp(1.5rem, 4.8vw, 66px)",
              }}
            >
              {resolvedTitle}
            </h2>
          )}

          {resolvedSubtitle && (
            <p
              className="mb-6 max-w-xl"
              style={{
                color: resolvedSubtitleColor,
                fontSize: "clamp(0.875rem, 2.2vw, 30px)",
              }}
            >
              {resolvedSubtitle}
            </p>
          )}

          {resolvedLinkText && (
            <span
              className="inline-flex items-center gap-2 rounded-full px-6 py-2.5 text-sm font-medium backdrop-blur-md transition-all duration-200"
              style={{ color: resolvedLinkColor }}
            >
              {resolvedLinkText}
              <ArrowLeft className="h-4 w-4" />
            </span>
          )}
        </div>
      )}
    </Link>
  );
};

export default BlogCategoryBanner;
