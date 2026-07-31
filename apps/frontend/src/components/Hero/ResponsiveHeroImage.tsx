import { getImageProps } from "next/image";
import Link from "next/link";
import imageLoader from "@/utils/imageLoader";
import {
  resolveHeroSlideMobileImage,
  type HeroSlideConfig,
} from "@/types/super-admin/heroSliderV3";

const HERO_DESKTOP_WIDTH = 1360;
const HERO_DESKTOP_HEIGHT = 581;
const HERO_MOBILE_WIDTH = 361;
const HERO_MOBILE_HEIGHT = 387;

export default function ResponsiveHeroImage({
  slide,
  eager,
}: {
  slide: HeroSlideConfig;
  eager: boolean;
}) {
  const mobile = resolveHeroSlideMobileImage(slide);
  const common = {
    alt: mobile.alt,
    sizes: "100vw",
    quality: 90,
    loader: imageLoader,
  } as const;

  const {
    props: { srcSet: desktopSrcSet },
  } = getImageProps({
    ...common,
    src: slide.imageUrl,
    alt: slide.imageAlt || mobile.alt,
    width: HERO_DESKTOP_WIDTH,
    height: HERO_DESKTOP_HEIGHT,
    sizes: "(max-width: 1360px) 100vw, 1360px",
  });
  const {
    props: { srcSet: mobileSrcSet, ...imageProps },
  } = getImageProps({
    ...common,
    src: mobile.url,
    width: HERO_MOBILE_WIDTH,
    height: HERO_MOBILE_HEIGHT,
    loading: eager ? "eager" : "lazy",
    fetchPriority: eager ? "high" : "auto",
  });

  const picture = (
    <picture className="block h-full w-full">
      <source media="(min-width: 1024px)" srcSet={desktopSrcSet} />
      <source media="(max-width: 1023px)" srcSet={mobileSrcSet} />
      <img
        {...imageProps}
        alt={mobile.alt}
        className="block h-full w-full object-cover"
      />
    </picture>
  );

  if (!slide.link?.href) return picture;
  return (
    <Link href={slide.link.href} className="block h-full w-full">
      {picture}
    </Link>
  );
}

