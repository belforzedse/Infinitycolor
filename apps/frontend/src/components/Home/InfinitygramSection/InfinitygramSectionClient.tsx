"use client";

import { useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import type { SocialFeedPost } from "@repo/social-posts";
import InfinitygramRichPosts from "./InfinitygramRichPosts";
import { noteEnhancementLoaded, useAdaptiveQuality } from "@/lib/adaptive-quality";

type InfinitygramSectionClientProps = {
  posts: readonly SocialFeedPost[];
};

const INFINITYGRAM_URL = "https://infinitygram.co";
const EXTERNAL_LINK_PROPS = {
  target: "_blank",
  rel: "noopener noreferrer",
} as const;

export default function InfinitygramSectionClient({ posts }: InfinitygramSectionClientProps) {
  const quality = useAdaptiveQuality();
  const staticMedia = quality.media === "economy";
  const visiblePosts = posts.filter((post, index) => {
    const variantLimit = post.desktopVariant === "xl" ? 2 : 4;
    const precedingVariantCount = posts
      .slice(0, index + 1)
      .filter((candidate) => candidate.desktopVariant === post.desktopVariant).length;
    return precedingVariantCount <= variantLimit;
  });

  useEffect(() => {
    if (!staticMedia) noteEnhancementLoaded("social-media");
  }, [staticMedia]);

  return (
    <section
      dir="rtl"
      aria-labelledby="home-infinitygram-heading"
      className="overflow-hidden bg-[#252220] text-white"
    >
      <div className="mx-auto w-full max-w-[1360px] px-2 py-8 sm:px-5 lg:px-[60px] lg:py-10 3xl:max-w-[1440px] 4xl:max-w-[1760px] 4xl:px-20">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h2
            id="home-infinitygram-heading"
            className="flex items-center gap-2 text-right font-peyda-fanum text-3xl font-normal leading-[37px] text-white"
          >
            <Image
              src="/infinitygram-icon.svg"
              alt=""
              width={32}
              height={32}
              className="block shrink-0"
            />
            <span>اینفینیتی‌گرام</span>
          </h2>

          <Link
            href={INFINITYGRAM_URL}
            target={EXTERNAL_LINK_PROPS.target}
            rel={EXTERNAL_LINK_PROPS.rel}
            className="pressable hidden shrink-0 items-center justify-center rounded-full border-2 border-white px-5 py-2 text-sm font-medium uppercase tracking-[0.08em] text-white transition-colors hover:bg-white hover:text-[#252220] sm:inline-flex"
          >
            <span>FOLLOW</span>
          </Link>
        </div>

        <InfinitygramRichPosts posts={visiblePosts} staticMedia={staticMedia} />

        <Link
          href={INFINITYGRAM_URL}
          target={EXTERNAL_LINK_PROPS.target}
          rel={EXTERNAL_LINK_PROPS.rel}
          className="pressable mx-auto mt-5 flex w-fit items-center justify-center rounded-full border-2 border-white px-5 py-2 text-sm font-medium uppercase tracking-[0.08em] text-white transition-colors hover:bg-white hover:text-[#252220] sm:hidden"
        >
          <span>FOLLOW</span>
        </Link>
      </div>
    </section>
  );
}
