"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoryRailProps, StoryRailStory } from "./types";
import { StoriesAvatarList } from "./StoriesAvatarList";
import { sortStoriesNewestFirst } from "./story-utils";

const StoriesViewerModal = lazy(() =>
  import("./StoriesViewerModal").then((module) => ({ default: module.StoriesViewerModal })),
);

function joinClasses(...classes: Array<string | undefined | false>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Distance scrolled from the rail's own start edge, and the maximum.
 *
 * Browsers disagree on `scrollLeft` in RTL: Chrome and Firefox count down from
 * 0 into negatives, older WebKit counts up from 0. Normalising to "how far from
 * the start" keeps the button disabled states correct under both.
 */
function railScrollMetrics(element: HTMLElement, isRtl: boolean) {
  const max = Math.max(0, element.scrollWidth - element.clientWidth);
  const raw = element.scrollLeft;
  const fromStart = !isRtl ? raw : raw <= 0 ? -raw : max - raw;
  return { max, fromStart };
}

function ChevronIcon({ pointsLeft }: { pointsLeft: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <polyline points={pointsLeft ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
    </svg>
  );
}

function RailPaginationButton({
  side,
  isRtl,
  disabled,
  label,
  onClick,
}: {
  side: "start" | "end";
  isRtl: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  // "start"/"end" are reading-order, so which physical edge they sit on — and
  // which way the chevron points — flips with direction.
  const onLeftEdge = isRtl ? side === "end" : side === "start";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={joinClasses(
        "absolute top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full",
        "border border-slate-200 bg-white/95 text-slate-700 shadow-sm backdrop-blur-sm transition",
        "hover:bg-white hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary",
        "disabled:pointer-events-none disabled:opacity-0",
        // Pointer-only: touch users swipe, and at mobile width these would
        // cover the first and last avatar.
        "md:flex",
        onLeftEdge ? "-left-3" : "-right-3",
      )}
    >
      <ChevronIcon pointsLeft={onLeftEdge} />
    </button>
  );
}

export function StoryRail<TStory extends StoryRailStory = StoryRailStory>({
  stories,
  seenIds = new Set<number>(),
  seenItems,
  onMarkSeen,
  resolveMediaUrl,
  heading,
  headingId = "stories-rail-heading",
  dir = "rtl",
  className,
  classNames,
  viewerClassNames,
  mobileLayout = "card",
  renderMobileBadge,
  emptyPreviewLabel = "Video",
  unavailableText = "Story unavailable",
  viewerLabels,
  onMediaIssue,
  showPagination = false,
  paginationLabels,
}: StoryRailProps<TStory>) {
  const useAvatarOnMobile = mobileLayout === "avatar";
  const orderedStories = useMemo(() => sortStoriesNewestFirst(stories), [stories]);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const isRtl = dir === "rtl";

  const syncScrollState = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const { max, fromStart } = railScrollMetrics(element, isRtl);
    setAtStart(fromStart <= 1);
    setAtEnd(fromStart >= max - 1);
  }, [isRtl]);

  useEffect(() => {
    if (!showPagination) return;
    const element = scrollerRef.current;
    if (!element) return;

    syncScrollState();
    element.addEventListener("scroll", syncScrollState, { passive: true });

    // The rail's overflow changes with viewport width and with how many stories
    // loaded, so width alone is not enough to know whether arrows are needed.
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(syncScrollState);
      observer.observe(element);
      if (element.firstElementChild) observer.observe(element.firstElementChild);
    } else {
      window.addEventListener("resize", syncScrollState);
    }

    return () => {
      element.removeEventListener("scroll", syncScrollState);
      if (observer) observer.disconnect();
      else window.removeEventListener("resize", syncScrollState);
    };
  }, [showPagination, syncScrollState, orderedStories.length]);

  const scrollByPage = useCallback(
    (towardsEnd: boolean) => {
      const element = scrollerRef.current;
      if (!element) return;
      // A page is most of the visible width, keeping a sliver of context.
      const step = Math.max(120, element.clientWidth * 0.8);
      // `scrollBy` left is a physical direction in both writing modes, so in RTL
      // moving towards later stories means moving left.
      const physical = (towardsEnd ? 1 : -1) * (isRtl ? -1 : 1) * step;
      const prefersReducedMotion =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      element.scrollBy({ left: physical, behavior: prefersReducedMotion ? "auto" : "smooth" });
    },
    [isRtl],
  );

  const handleClose = useCallback(() => setViewerOpen(false), []);

  const handleStoryView = useCallback(
    (storyId: number, itemKey: string) => {
      void onMarkSeen(storyId, itemKey);
    },
    [onMarkSeen],
  );

  const handleAvatarClick = useCallback((index: number) => {
    // Deliberately does not mark seen: the viewer reports the story it lands on through
    // `onStoryView` as soon as it mounts. Marking here as well produced two view records
    // for every story the user opened.
    setActiveIndex(index);
    setViewerOpen(true);
  }, []);

  if (!orderedStories.length) return null;

  return (
    <>
      <section
        className={joinClasses(
          "flex w-full flex-col gap-5 p-0",
          heading ? "items-end" : "items-stretch",
          className,
          classNames?.root,
        )}
        dir={dir}
        aria-labelledby={heading ? headingId : undefined}
      >
        {heading ? (
          <h2
            id={headingId}
            className={joinClasses(
              "self-stretch text-right font-peyda text-2xl font-bold leading-[21px] text-[#424242]",
              classNames?.heading,
            )}
          >
            {heading}
          </h2>
        ) : null}

        <div className="relative w-full min-w-0">
        {showPagination ? (
          <>
            <RailPaginationButton
              side="start"
              isRtl={isRtl}
              disabled={atStart}
              label={paginationLabels?.previous ?? "Previous stories"}
              onClick={() => scrollByPage(false)}
            />
            <RailPaginationButton
              side="end"
              isRtl={isRtl}
              disabled={atEnd}
              label={paginationLabels?.next ?? "More stories"}
              onClick={() => scrollByPage(true)}
            />
          </>
        ) : null}
        <div
          ref={scrollerRef}
          className={joinClasses(
            "stories-rail w-full min-w-0 overflow-x-auto scrollbar-hide",
            useAvatarOnMobile
              ? "h-20 min-h-0"
              : "min-h-[188px] lg:h-20 lg:min-h-0",
            classNames?.scroller,
          )}
          dir={dir}
        >
          <div
            dir={dir}
            className={joinClasses(
              "flex w-max min-w-full flex-row justify-start gap-4",
              useAvatarOnMobile
                ? "h-20 min-h-0 items-center"
                : "min-h-[188px] items-stretch lg:h-20 lg:min-h-0 lg:items-center",
              classNames?.scrollerInner,
            )}
          >
            <StoriesAvatarList
              stories={orderedStories}
              seenIds={seenIds}
              seenItems={seenItems}
              onAvatarClick={handleAvatarClick}
              resolveMediaUrl={resolveMediaUrl}
              dir={dir}
              mobileLayout={mobileLayout}
              renderMobileBadge={renderMobileBadge}
              emptyPreviewLabel={emptyPreviewLabel}
              classNames={classNames}
            />
          </div>
        </div>
        </div>
      </section>

      {viewerOpen ? (
        <Suspense fallback={null}>
          <StoriesViewerModal
            stories={orderedStories}
            seenIds={seenIds}
            seenItems={seenItems}
            isOpen={viewerOpen}
            initialIndex={activeIndex}
            onClose={handleClose}
            onStoryView={handleStoryView}
            resolveMediaUrl={resolveMediaUrl}
            unavailableText={unavailableText}
            classNames={viewerClassNames}
            dir={dir}
            labels={viewerLabels}
            onMediaIssue={onMediaIssue}
          />
        </Suspense>
      ) : null}
    </>
  );
}
