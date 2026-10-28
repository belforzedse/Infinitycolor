import Image from "next/image";
import { ABOUT_PRICE_BANNERS } from "./aboutBannerData";

export default function AboutBanners() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
      {ABOUT_PRICE_BANNERS.map((banner) => (
        <div
          key={banner.id}
          className="relative aspect-[1024/542] w-full overflow-hidden rounded-2xl bg-slate-100"
        >
          <Image
            src={banner.src}
            alt=""
            fill
            className="object-cover"
            sizes="(max-width: 768px) 100vw, 50vw"
            loading="lazy"
          />
        </div>
      ))}
    </div>
  );
}
