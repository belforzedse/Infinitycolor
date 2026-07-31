import Link from "next/link";
import ResponsiveHeroImage from "./ResponsiveHeroImage";
import type { HeroSlideConfig } from "@/types/super-admin/heroSliderV3";

export default function HeroStaticFallback({
  slides,
}: {
  slides: HeroSlideConfig[];
}) {
  const firstSlide = slides[0];
  if (!firstSlide) return null;

  return (
    <div
      className="relative mx-auto aspect-[361/387] w-full overflow-hidden rounded-[18px] bg-[#f9f1ee] lg:aspect-[1360/581] lg:rounded-[34px]"
      data-aq-hero="static"
    >
      <ResponsiveHeroImage slide={firstSlide} eager />
      {slides.length > 1 ? (
        <nav className="sr-only" aria-label="پیوندهای بنرهای فروشگاه">
          <ul>
            {slides.slice(1).map((slide) =>
              slide.link?.href ? (
                <li key={slide.id}>
                  <Link href={slide.link.href}>
                    {slide.imageAlt || slide.mobileImageAlt || "مشاهده بنر"}
                  </Link>
                </li>
              ) : null,
            )}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}

