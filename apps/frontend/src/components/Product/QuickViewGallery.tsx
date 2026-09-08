import Image from "next/image";
import { faNum } from "@/utils/faNum";
import imageLoader from "@/utils/imageLoader";

interface QuickViewGalleryProps {
  images: string[];
  title: string;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  hasDiscount?: boolean;
  discountPercent?: number;
}

export default function QuickViewGallery({
  images,
  title,
  selectedIndex,
  onSelectIndex,
  hasDiscount,
  discountPercent,
}: QuickViewGalleryProps) {
  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-3xl bg-neutral-50 ring-1 ring-black/5">
        {/*
          The shared Modal always renders its own header close control, so this
          second "بستن" button sat directly beside it — two adjacent controls for
          one action. Keeping the shared one leaves quick view consistent with
          every other dialog.
        */}
        {/* Discount badge on image */}
        {hasDiscount && discountPercent && (
          <div className="absolute left-3 top-3 z-10 rounded-full bg-infinity-primary px-3 py-1 text-xs font-medium text-white shadow-sm">
            {faNum(discountPercent)}% تخفیف
          </div>
        )}

        {/* Main image — square keeps it compact; full PDP has the taller ratio */}
        <div className="relative aspect-square">
          {images.length > 0 ? (
            <Image
              src={images[Math.min(selectedIndex, images.length - 1)]}
              alt={title}
              fill
              className="object-contain p-3 sm:p-4"
              sizes="(max-width: 1024px) 100vw, 50vw"
              priority
              loader={imageLoader}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-gray-400">
              <span>تصویر موجود نیست</span>
            </div>
          )}
        </div>
      </div>

      {/* Thumbnails */}
      {images.length > 1 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {images.map((img, index) => {
            const active = selectedIndex === index;
            return (
              <button
                key={img + index}
                type="button"
                onClick={() => onSelectIndex(index)}
                className={[
                  "relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-xl ring-1 transition",
                  active
                    ? "ring-infinity-primary"
                    : "ring-black/10 hover:ring-infinity-primary-lighter",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary",
                ].join(" ")}
                aria-label={`تصویر ${faNum(index + 1)}`}
                aria-current={active ? "true" : "false"}
              >
                <Image
                  src={img}
                  alt={`${title} - تصویر ${faNum(index + 1)}`}
                  fill
                  className="object-cover"
                  sizes="64px"
                  loader={imageLoader}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
