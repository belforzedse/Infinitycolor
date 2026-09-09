"use client";

import React from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft } from "lucide-react";

interface BlogCategoryBannerProps {
  title?: string;
  subtitle?: string;
  backgroundImage?: string;
  href: string;
  linkText?: string;
  ariaLabel?: string;
  textColor?: string;
  linkColor?: string;
  subtitleColor?: string;
  height?: "sm" | "md" | "lg";
  className?: string;
}

const heightClasses = {
  sm: "h-[200px] md:h-[240px]",
  md: "h-[340px] md:h-[380px]",
  lg: "h-[300px] md:h-[490px]",
};

const visibleText = (value?: string) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
};

const BlogCategoryBanner: React.FC<BlogCategoryBannerProps> = ({
  title,
  subtitle,
  backgroundImage,
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

  return (
    <Link
      href={href}
      aria-label={accessibleName}
      className={`relative block w-full overflow-hidden rounded-2xl ${heightClasses[height]} ${className}`}
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
            <h2 className="mb-3 text-3xl leading-snug md:text-[66px]" style={{ color: resolvedTitleColor }}>
              {resolvedTitle}
            </h2>
          )}

          {resolvedSubtitle && (
            <p className="text-md mb-6 max-w-xl md:text-[30px]" style={{ color: resolvedSubtitleColor }}>
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
