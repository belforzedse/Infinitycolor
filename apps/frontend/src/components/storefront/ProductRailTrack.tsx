import { cn } from "@/lib/utils";
import type { HTMLAttributes, ReactNode } from "react";

/**
 * The one mobile product carousel.
 *
 * Below `lg` this is a native scroll-snap track: every product is in the DOM and
 * the browser owns the gesture, so touch dragging, momentum, snapping and
 * vertical-scroll passthrough all come for free. That is why there are no
 * pointer handlers, no `touch-action`, and no `preventDefault` here — the
 * versions of this rail that tried to drive scrolling from JavaScript are
 * exactly the ones that lost touch support.
 *
 * At `lg` and above it becomes the same CSS grid the rails used before, and
 * paging is done by toggling each card's visibility rather than by slicing the
 * array, so desktop pagination never removes the nodes the mobile track scrolls.
 *
 * The mobile card width and the mobile gap are a matched pair: two cards plus
 * one 6px gap fill the viewport, leaving a peek of the third. Change one and you
 * must change the other, which is why neither is a prop.
 */

type ProductRailTrackProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  /** Desktop grid columns and gaps; the mobile track is fixed. */
  desktopClassName?: string;
};

export function ProductRailTrack({
  children,
  className,
  desktopClassName,
  ...props
}: ProductRailTrackProps) {
  return (
    <div
      className={cn(
        "scrollbar-hide flex snap-x snap-mandatory gap-1.5 overflow-x-auto scroll-smooth",
        "lg:grid lg:snap-none lg:gap-4 lg:overflow-visible",
        desktopClassName,
        className,
      )}
      style={{
        // iOS momentum scrolling, and no scrollbar gutter on desktop browsers
        // that would otherwise reserve space inside the rail.
        WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none",
        msOverflowStyle: "none",
      }}
      {...props}
    >
      {children}
    </div>
  );
}

type ProductRailSlideProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
};

/** One card in the track: half the viewport on mobile, a grid cell on desktop. */
export function ProductRailSlide({
  children,
  className,
  ...props
}: ProductRailSlideProps) {
  return (
    <div
      data-product-card-slide
      className={cn(
        "w-[calc(50%-0.1875rem)] shrink-0 snap-start",
        "lg:w-auto lg:min-w-0 lg:snap-none",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
