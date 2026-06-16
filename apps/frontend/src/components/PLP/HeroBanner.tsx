import Image from "next/image";
import Link from "next/link";

interface PLPHeroBannerProps {
  initialTitle?: string;
}

const PLP_HERO_IMAGE = "/images/plp-hero.png";

export default function PLPHeroBanner({ initialTitle }: PLPHeroBannerProps) {
  const title = initialTitle || "همه محصولات";

  return (
    <Link href="/" className="block w-full">
      <div className="relative h-[396px] w-full overflow-hidden rounded-2xl">
        <Image
          src={PLP_HERO_IMAGE}
          alt={title}
          fill
          className="object-cover"
          sizes="(max-width: 1280px) 100vw, 1280px"
          priority
        />
      </div>
    </Link>
  );
}
