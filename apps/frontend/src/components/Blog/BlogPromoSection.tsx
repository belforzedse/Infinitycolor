"use client";

import React from "react";
import Link from "next/link";
import Image from "next/image";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import type { PromoData, PromoLink } from "@/utils/blogShortcodes";

/**
 * The shop's promotional block inside an article.
 *
 * On WordPress this is a theme shortcode whose layout lives entirely in theme
 * CSS. The importer stores it as data and this component is the storefront's own
 * rendering of it — none of the theme's markup, classes or frame images are
 * carried over, so it cannot arrive flattened the way the raw
 * `<section class="blog-middle-section">` did.
 *
 * The composition follows the live WordPress block: a pale lilac band with navy
 * cut-out shapes, the illustration flush to one edge, and a white card holding
 * the heading, the line under it and the two actions. On a phone the two stack,
 * illustration first, exactly as the theme does.
 *
 * All text is React-escaped; the href allowlist lives in the parser.
 */

const INSTAGRAM_GLYPH = (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 shrink-0" fill="currentColor">
    <path d="M12 2.2c3.2 0 3.6 0 4.9.07 1.2.05 1.8.25 2.2.42.6.22 1 .48 1.4.9.4.4.7.8.9 1.4.2.4.4 1 .4 2.2.1 1.3.1 1.7.1 4.9s0 3.6-.1 4.9c0 1.2-.2 1.8-.4 2.2-.2.6-.5 1-.9 1.4-.4.4-.8.7-1.4.9-.4.2-1 .4-2.2.4-1.3.1-1.7.1-4.9.1s-3.6 0-4.9-.1c-1.2 0-1.8-.2-2.2-.4-.6-.2-1-.5-1.4-.9-.4-.4-.7-.8-.9-1.4-.2-.4-.4-1-.4-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.9c0-1.2.2-1.8.4-2.2.2-.6.5-1 .9-1.4.4-.4.8-.7 1.4-.9.4-.2 1-.4 2.2-.4C8.4 2.2 8.8 2.2 12 2.2Zm0 1.8c-3.1 0-3.5 0-4.7.07-.9 0-1.4.2-1.7.3-.4.2-.7.4-1 .6-.2.3-.5.6-.6 1-.1.3-.3.8-.3 1.7C3.6 8.9 3.6 9.2 3.6 12s0 3.1.07 4.3c0 .9.2 1.4.3 1.7.2.4.4.7.6 1 .3.2.6.5 1 .6.3.1.8.3 1.7.3 1.2.07 1.6.07 4.7.07s3.5 0 4.7-.07c.9 0 1.4-.2 1.7-.3.4-.2.7-.4 1-.6.2-.3.5-.6.6-1 .1-.3.3-.8.3-1.7.07-1.2.07-1.5.07-4.3s0-3.1-.07-4.3c0-.9-.2-1.4-.3-1.7-.2-.4-.4-.7-.6-1-.3-.2-.6-.5-1-.6-.3-.1-.8-.3-1.7-.3C15.5 4 15.1 4 12 4Zm0 3.1a4.9 4.9 0 1 1 0 9.8 4.9 4.9 0 0 1 0-9.8Zm0 8a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2Zm6.3-8.2a1.15 1.15 0 1 1-2.3 0 1.15 1.15 0 0 1 2.3 0Z" />
  </svg>
);

function ActionLink({
  link,
  className,
  children,
}: {
  link: PromoLink;
  className: string;
  children?: React.ReactNode;
}) {
  // A site-relative href is an internal route; anything else opens away.
  if (link.href.startsWith("/")) {
    return (
      <Link href={link.href} className={className}>
        {children}
        {link.label}
      </Link>
    );
  }
  return (
    <a href={link.href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      {link.label}
    </a>
  );
}

const BlogPromoSection: React.FC<{ data: PromoData }> = ({ data }) => {
  const { title, body, cta, social, image } = data;

  return (
    <section
      dir="rtl"
      aria-label={title || "معرفی محصولات"}
      className="not-prose relative my-8 overflow-hidden rounded-2xl bg-[#f2e9f1]"
    >
      {/* Decorative shapes, drawn here rather than loaded from the theme. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -left-8 -top-14 h-28 w-28 rounded-full bg-[#2b3a63]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-14 left-14 hidden h-28 w-28 rounded-full bg-[#2b3a63] sm:block"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-6 left-44 hidden h-20 w-20 rounded-full bg-white/70 sm:block"
      />

      {/* In RTL `flex-row` puts the first child on the right, so the card sits
          right and the illustration left, as the theme lays it out. */}
      <div className="relative flex flex-col sm:flex-row sm:items-stretch">
        <div className="flex flex-1 items-center p-3 sm:p-5">
          <div className="w-full rounded-xl bg-white p-4 text-right sm:p-6">
            {title ? (
              <p className="text-base font-bold leading-8 text-[#2b3a63] sm:text-lg">{title}</p>
            ) : null}
            {body ? (
              <p className="text-sm mt-1 leading-7 text-[#6d5f97] sm:text-base">{body}</p>
            ) : null}

            {cta || social ? (
              <div className="mt-4 flex flex-wrap items-center justify-start gap-2 sm:mt-5 sm:gap-3">
                {cta ? (
                  <ActionLink
                    link={cta}
                    className="text-xs inline-flex min-h-11 items-center justify-center rounded-lg bg-[#2b3a63] px-4 font-medium text-white transition-colors hover:bg-[#1f2b4b] sm:text-sm sm:px-5"
                  />
                ) : null}
                {social ? (
                  <ActionLink
                    link={social}
                    className="text-xs inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#d9c7e6] bg-white px-3 font-medium text-[#5b4b8a] transition-colors hover:bg-[#faf6fd] sm:text-sm"
                  >
                    {INSTAGRAM_GLYPH}
                  </ActionLink>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {image ? (
          <div className="order-first flex shrink-0 items-end justify-center sm:order-none sm:w-[38%]">
            <Image
              src={resolveAssetUrl(image.url)}
              alt={image.alt || ""}
              width={420}
              height={420}
              className="h-auto max-h-72 w-auto max-w-full object-contain object-bottom sm:max-h-none sm:w-full"
              sizes="(max-width: 640px) 80vw, 300px"
            />
          </div>
        ) : null}
      </div>
    </section>
  );
};

export default BlogPromoSection;
