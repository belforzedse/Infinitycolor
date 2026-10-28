"use client";

import Image from "next/image";
import imageLoader from "@/utils/imageLoader";
import { useRef, useEffect, useState, useCallback } from "react";
import { useAdaptiveQuality } from "@/lib/adaptive-quality";

type Props = {
  assets: {
    id: string;
    type: "video" | "image";
    src: string;
    thumbnail: string;
    alt: string;
  }[];
  selectedImage: string;
  setSelectedImage: (id: string) => void;
};

export default function PDPHeroGalleryThumbnailList(props: Props) {
  const { assets, selectedImage, setSelectedImage } = props;
  const [showBlur, setShowBlur] = useState(true);
  const quality = useAdaptiveQuality();

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const preloadSrc = useCallback((src: string) => {
    if (typeof window === "undefined") return;
    if (!src.trim()) return;
    try {
      const img = new window.Image();
      img.src = src;
    } catch {}
  }, []);
  const scrollToImage = useCallback(
    (index: number) => {
      const container = scrollContainerRef.current;

      if (!container || !container.clientWidth || !container.clientHeight) {
        return;
      }

      const target = container.querySelector<HTMLElement>(`[data-thumbnail-index="${index}"]`);

      if (!target) return;

      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();

      let left = 0;
      let top = 0;

      if (container.scrollWidth > container.clientWidth) {
        if (targetRect.left < containerRect.left) {
          left = targetRect.left - containerRect.left;
        } else if (targetRect.right > containerRect.right) {
          left = targetRect.right - containerRect.right;
        }
      }

      if (container.scrollHeight > container.clientHeight) {
        if (targetRect.top < containerRect.top) {
          top = targetRect.top - containerRect.top;
        } else if (targetRect.bottom > containerRect.bottom) {
          top = targetRect.bottom - containerRect.bottom;
        }
      }

      if (left || top) {
        container.scrollBy({
          left,
          top,
          behavior: quality.motion === "minimal" ? "auto" : "smooth",
        });
      }
    },
    [quality.motion],
  );
  const handleScroll = () => {
    if (scrollContainerRef.current) {
      const {
        scrollTop,
        // scrollLeft,
        // scrollWidth,
        scrollHeight,
        clientHeight,
        // clientWidth,
      } = scrollContainerRef.current;

      // Check if we're in mobile view
      const isMobile = window.innerWidth < 768;

      if (isMobile) {
        // const isAtEnd = scrollLeft + clientWidth >= scrollWidth - 70;
        setShowBlur(false);
      } else {
        const isAtBottom = scrollTop + clientHeight >= scrollHeight - 70;
        setShowBlur(!isAtBottom);
      }
    }
  };

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer) {
      scrollContainer.addEventListener("scroll", handleScroll);
      const frameId = requestAnimationFrame(handleScroll);

      return () => {
        cancelAnimationFrame(frameId);
        scrollContainer.removeEventListener("scroll", handleScroll);
      };
    }
  }, []);

  // Add effect to handle selectedImage changes
  useEffect(() => {
    const selectedIndex = assets.findIndex((asset) => asset.id === selectedImage);
    if (selectedIndex !== -1 && scrollContainerRef.current) {
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        scrollToImage(selectedIndex);
      });
    }
  }, [selectedImage, assets, scrollToImage]);

  return (
    <div
      ref={scrollContainerRef}
      data-testid="pdp-thumbnails"
      className="relative h-auto w-full overflow-x-auto px-1 py-1 [-webkit-overflow-scrolling:touch] [overscroll-behavior-x:contain] xl:h-[calc((112px*5/4*4)+(0.5rem*3)+0.5rem)] xl:max-h-[calc(100vh-var(--header-offset,88px)-1rem)] xl:w-[120px] xl:overflow-y-auto xl:overflow-x-hidden"
    >
      <div className="flex min-w-max flex-row-reverse flex-nowrap gap-2 xl:w-full xl:min-w-0 xl:flex-col xl:flex-wrap">
        {assets.map((asset, index) => (
          <button
            type="button"
            key={asset.id}
            data-thumbnail-index={index}
            aria-label={`نمایش ${asset.type === "video" ? "ویدیو" : "تصویر"} ${index + 1}: ${asset.alt}`}
            aria-pressed={asset.id === selectedImage}
            onClick={() => {
              setSelectedImage(asset.id);
            }}
            onMouseEnter={() => {
              if (quality.media === "high" && asset.type === "image") {
                preloadSrc(asset.src);
              }
            }}
            className={`relative aspect-[4/5] w-[84px] flex-shrink-0 cursor-pointer overflow-visible rounded-2xl p-0.5 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 md:w-[112px] ${
              asset.id === selectedImage ? "ring-2 ring-infinity-primary" : "ring-1 ring-black/10"
            }`}
          >
            <div
              className={`relative h-full w-full ${
                asset.id === selectedImage ? "opacity-60" : "opacity-100"
              } overflow-hidden rounded-[14px]`}
            >
              <Image
                fill
                src={asset.thumbnail.trim() || "/images/cart/empty-cart.png"}
                alt={asset.alt}
                sizes="(max-width: 768px) 84px, 112px"
                loader={imageLoader}
                loading="lazy"
                placeholder="blur"
                blurDataURL="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTM5IiBoZWlnaHQ9IjEzMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZjNmNGY2Ii8+PC9zdmc+"
                className="object-cover"
              />
              {/* Gradient overlay for videos */}
              {asset.type === "video" && (
                <div className="absolute inset-0 bg-gradient-to-br from-black/10 via-transparent to-transparent" />
              )}
            </div>

            {asset.type === "video" && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="group/video-thumb flex items-center justify-center transition-all duration-300">
                  <div className="absolute h-12 w-12 rounded-full bg-white/95 shadow-lg ring-2 ring-infinity-primary-lighter/50 backdrop-blur-sm transition-all duration-300 group-hover/video-thumb:scale-110 group-hover/video-thumb:shadow-xl group-hover/video-thumb:ring-infinity-primary-light/70" />
                  <svg
                    className="relative h-5 w-5 text-infinity-primary transition-transform duration-300 group-hover/video-thumb:scale-110"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Fade */}
      {showBlur && (
        <div
          className="pointer-events-none bottom-0 left-0 hidden h-16 w-full bg-gradient-to-b from-white/0 via-white/70 to-white opacity-100 transition-opacity duration-200 xl:sticky xl:block"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
