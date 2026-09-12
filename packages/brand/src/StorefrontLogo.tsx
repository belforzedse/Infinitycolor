import Image from "next/image";
import Link from "next/link";

export type StorefrontLogoProps = {
  /** Defaults to `/` (store home). */
  href?: string;
  /**
   * Defaults to `false`. The logo is a fallback way back to the store rather
   * than a likely next click, and prefetching it pulled the whole home page
   * segment on every product and listing view.
   */
  prefetch?: boolean;
  /**
   * Fixed display size in px for both dimensions. When omitted, uses storefront
   * defaults (responsive, up to 210×72).
   */
  width?: number;
  height?: number;
};

/**
 * Customer-facing logo (`/images/full-logo.png`).
 * Sizing uses inline styles so it works in apps whose Tailwind content paths do not scan `packages/brand` (e.g. social uses v4 `@import` only).
 */
export function StorefrontLogo({
  href = "/",
  prefetch = false,
  width: widthProp,
  height: heightProp,
}: StorefrontLogoProps) {
  const fixed =
    widthProp !== undefined &&
    heightProp !== undefined &&
    widthProp > 0 &&
    heightProp > 0;

  const intrinsicW = fixed ? widthProp : 210;
  const intrinsicH = fixed ? heightProp : 72;

  return (
    <Link
      href={href}
      prefetch={prefetch}
      style={{ display: "inline-block", lineHeight: 0 }}
    >
      <Image
        src="/images/full-logo.png"
        alt="Logo"
        width={intrinsicW}
        height={intrinsicH}
        preload
        sizes={fixed ? `${widthProp}px` : "(max-width: 768px) 150px, 210px"}
        style={
          fixed
            ? {
                display: "block",
                width: `${widthProp}px`,
                height: `${heightProp}px`,
                objectFit: "contain",
              }
            : {
                display: "block",
                height: "clamp(44px, 12vw, 72px)",
                width: "auto",
                maxWidth: "min(210px, 100%)",
                objectFit: "contain",
              }
        }
      />
    </Link>
  );
}
