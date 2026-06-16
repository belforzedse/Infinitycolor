import Link from "next/link";

interface PLPHeroBannerProps {
  initialTitle?: string;
}

const PLP_HERO_DESKTOP_IMAGE = "/images/plp-hero-desktop.png";
const PLP_HERO_MOBILE_IMAGE = "/images/plp-hero-mobile.png";

export default function PLPHeroBanner({ initialTitle }: PLPHeroBannerProps) {
  const title = initialTitle || "همه محصولات";

  return (
    <Link href="/" className="block w-full">
      <div className="aspect-[414/130] w-full overflow-hidden rounded-2xl md:aspect-[1360/400]">
        <picture>
          <source media="(max-width: 767px)" srcSet={PLP_HERO_MOBILE_IMAGE} />
          {/* eslint-disable-next-line @next/next/no-img-element -- The PLP hero needs art-directed desktop and mobile bitmap sources. */}
          <img
            src={PLP_HERO_DESKTOP_IMAGE}
            alt={title}
            width={1360}
            height={400}
            className="block h-full w-full object-cover"
            decoding="async"
            fetchPriority="high"
          />
        </picture>
      </div>
    </Link>
  );
}
