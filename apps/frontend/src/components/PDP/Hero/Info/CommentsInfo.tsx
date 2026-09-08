import StarIcon from "../../Icons/StarIcon";

type Props = {
  commentCount: number;
  rateCount: number;
  /** Kept for API compatibility; view count is intentionally not displayed to customers. */
  last24hoursSeenCount?: number;
  /** Takes the shopper to the review section, including its zero-review state. */
  onOpenComments?: () => void;
};

export default function PDPHeroInfoCommentsInfo(props: Props) {
  const { commentCount, rateCount, onOpenComments } = props;

  const label = commentCount > 0 ? `${commentCount} دیدگاه` : "بدون دیدگاه";

  return (
    <div className="flex flex-col md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-3">
        <span className="text-foreground-primary text-base">
          {/*
            This count reads as a link, so it has to behave like one. It was a
            bare <span> with no handler, leaving the advertised shortcut inert
            and unreachable by keyboard.
          */}
          <button
            type="button"
            onClick={onOpenComments}
            className="cursor-pointer rounded-sm text-actions-link underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-actions-link"
          >
            {label}
          </button>{" "}
          برای این محصول
        </span>

        {rateCount > 0 && (
          <>
            <div className="h-[24px] w-[1px] bg-slate-300" />

            <div className="flex items-center gap-1">
              <span className="text-foreground-primary text-sm md:text-xs">({rateCount}) نفر</span>

              <StarIcon />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
