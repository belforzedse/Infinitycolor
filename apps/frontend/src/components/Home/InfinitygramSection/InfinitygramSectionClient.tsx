"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import Link from "next/link";
import type { SocialFeedPost } from "@repo/social-posts";
import {
  noteEnhancementLoaded,
  useAdaptiveHydrated,
  useAdaptiveQuality,
} from "@/lib/adaptive-quality";

type InfinitygramSectionClientProps = {
  posts: readonly SocialFeedPost[];
};

const INFINITYGRAM_URL = "https://infinitygram.co";
const EXTERNAL_LINK_PROPS = {
  target: "_blank",
  rel: "noopener noreferrer",
} as const;

function hrefForPost(slug: string) {
  return `${INFINITYGRAM_URL}/post/${encodeURIComponent(slug)}`;
}

export default function InfinitygramSectionClient({ posts }: InfinitygramSectionClientProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const hydrated = useAdaptiveHydrated();
  const quality = useAdaptiveQuality();
  const [nearViewport, setNearViewport] = useState(false);
  const [RichPosts, setRichPosts] = useState<ComponentType<{
    posts: readonly SocialFeedPost[];
  }> | null>(null);
  const richMediaEligible = hydrated && nearViewport && quality.media !== "economy";
  let xlCount = 0;
  let smCount = 0;
  const visiblePosts = posts.filter((post) => {
    if (post.desktopVariant === "xl" && xlCount < 2) {
      xlCount += 1;
      return true;
    }
    if (post.desktopVariant === "sm" && smCount < 4) {
      smCount += 1;
      return true;
    }
    return false;
  });

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!richMediaEligible || RichPosts) return;
    let cancelled = false;
    import("./InfinitygramRichPosts")
      .then((module) => {
        if (cancelled) return;
        setRichPosts(() => module.default);
        noteEnhancementLoaded("social-media");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [RichPosts, richMediaEligible]);

  return (
    <section
      ref={sectionRef}
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
            <img
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

        {richMediaEligible && RichPosts ? (
          <RichPosts posts={visiblePosts} />
        ) : (
          <ul
            className="grid w-full min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
            dir="ltr"
            aria-label="پست‌های اینفینیتی‌گرام"
          >
            {visiblePosts.map((post) => (
              <li key={post.id} className="min-w-0">
                <Link
                  href={hrefForPost(post.slug)}
                  target={EXTERNAL_LINK_PROPS.target}
                  rel={EXTERNAL_LINK_PROPS.rel}
                  className="flex min-h-28 w-full items-end rounded-[20px] border border-white/25 bg-white/10 p-4 text-right font-peyda text-sm text-white outline-none transition-colors hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                  aria-label={`مشاهده پست ${post.title || post.imageAlt}`}
                >
                  <span dir="rtl" className="line-clamp-2">
                    {post.title || post.imageAlt || "مشاهده پست"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

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
