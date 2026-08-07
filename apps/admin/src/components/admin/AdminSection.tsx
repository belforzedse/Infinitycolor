import { cn } from "@/utils/tailwind";
import { CARD, CARD_PADDING, FLEX_TEXT, SECTION_GAP } from "./tokens";

/** Vertical rhythm container for a page's top-level sections. */
export function AdminStack({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn(SECTION_GAP, className)}>{children}</div>;
}

/** Plain surface with the shared radius, border and padding. */
export function AdminCard({
  children,
  padded = true,
  className,
}: {
  children: React.ReactNode;
  padded?: boolean;
  className?: string;
}) {
  return (
    <div className={cn(CARD, padded && CARD_PADDING, className)}>
      {children}
    </div>
  );
}

/**
 * A titled region of a detail page. Replaces the assorted inline
 * `rounded-2xl bg-white p-5/p-6` + hand-rolled heading combinations.
 */
export function AdminSection({
  title,
  description,
  actions,
  children,
  padded = true,
  className,
  contentClassName,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  padded?: boolean;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section className={cn(CARD, padded && CARD_PADDING, className)} dir="rtl">
      {(title || actions) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className={cn("flex flex-col gap-1", FLEX_TEXT)}>
            {title && (
              <h2 className="text-base font-medium text-slate-800">{title}</h2>
            )}
            {description && (
              <p className="text-xs text-slate-500">{description}</p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
      )}
      <div className={contentClassName}>{children}</div>
    </section>
  );
}
