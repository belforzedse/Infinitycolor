import Link from "next/link";
import {
  SITE_GIF_ASPECT_CLASS,
  SITE_GIF_DESKTOP_HEIGHT,
  SITE_GIF_DESKTOP_WIDTH,
  normalizeSiteGifImageUrl,
} from "@/constants/site-gif";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { cn } from "@/lib/utils";

export type SiteGifBannerPreviewMode = "responsive" | "desktop" | "mobile";

export type SiteGifBannerProps = {
  enabled: boolean;
  imageUrl: string;
  linkHref?: string;
  altText?: string;
  previewMode?: SiteGifBannerPreviewMode;
  className?: string;
};

function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export default function SiteGifBanner({
  enabled,
  imageUrl,
  linkHref,
  altText,
  previewMode = "responsive",
  className,
}: SiteGifBannerProps) {
  const trimmedImage = imageUrl?.trim() ?? "";
  if (!enabled || !trimmedImage) return null;

  const resolvedSrc = resolveAssetUrl(normalizeSiteGifImageUrl(trimmedImage));
  const trimmedHref = linkHref?.trim() ?? "";
  const alt = altText?.trim() || "گیف سایت";

  const widthClass =
    previewMode === "desktop"
      ? "w-full max-w-none"
      : previewMode === "mobile"
        ? "mx-auto w-full max-w-[390px]"
        : "w-full";

  const image = (
    // eslint-disable-next-line @next/next/no-img-element -- GIF animation requires native img
    <img
      src={resolvedSrc}
      alt={alt}
      width={SITE_GIF_DESKTOP_WIDTH}
      height={SITE_GIF_DESKTOP_HEIGHT}
      className="h-full w-full object-cover"
      // Native GIF animation is tier-independent; lazy loading only defers
      // off-screen transfer and never replaces the GIF with a static shell.
      loading="lazy"
      fetchPriority="low"
      decoding="async"
    />
  );

  const content = trimmedHref ? (
    isExternalHref(trimmedHref) ? (
      <a
        href={trimmedHref}
        target="_blank"
        rel="noopener noreferrer"
        className="block h-full w-full"
      >
        {image}
      </a>
    ) : (
      <Link href={trimmedHref} className="block h-full w-full">
        {image}
      </Link>
    )
  ) : (
    image
  );

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-xl",
        SITE_GIF_ASPECT_CLASS,
        widthClass,
        className,
      )}
    >
      {content}
    </div>
  );
}
