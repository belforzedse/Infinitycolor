/**
 * Shared layout rules for the admin.
 *
 * These are the values that used to be re-decided per page (three different
 * vertical rhythms, four card paddings, two dozen empty-state boxes). They are
 * plain class strings rather than new Tailwind config so they compose with
 * everything already in the codebase and stay greppable.
 *
 * Breakpoints follow the app's existing scale: `md` (768) is the phone/tablet
 * divide, `lg` (1024) is where lists switch from cards to tables.
 */

/** Outer page column. The shell already centres and caps at `max-w-screen-3xl`. */
export const PAGE_GUTTER = "px-0 md:px-0";

/** Vertical rhythm between top-level sections of a page. */
export const SECTION_GAP = "space-y-4 lg:space-y-6";

/** Standard surface. Matches `.card` in styles/components.css. */
export const CARD =
  "rounded-prominent border border-slate-100 bg-white shadow-sm";

/** Padding inside a card. Tighter on phones, roomier on desktop. */
export const CARD_PADDING = "p-4 md:p-5 lg:p-6";

/**
 * Minimum comfortable touch target. WCAG 2.2 AA requires 24x24 with spacing;
 * we target ~44px on phones and relax to 36-40px on pointer-first widths.
 */
export const TOUCH_TARGET = "min-h-[44px] md:min-h-[36px]";

/** Interactive control height (buttons, inputs, selects). */
export const CONTROL_HEIGHT = "h-11 md:h-10";

/** Icon-only control. */
export const ICON_BUTTON =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-control md:h-9 md:w-9";

/** Focus ring used on every interactive primitive here. */
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-1";

/**
 * Guards against long Persian names and large totals blowing out a flex row.
 * Applied to the growing child; pair with `shrink-0` on the fixed sibling.
 */
export const FLEX_TEXT = "min-w-0 break-words";
