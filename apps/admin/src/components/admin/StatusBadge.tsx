import { cn } from "@/utils/tailwind";
import type { StatusTone } from "@/utils/statusTranslations";

export type BadgeTone = StatusTone | "neutral";

/**
 * Single source of truth for tone -> colour. `getOrderStatusMeta()` and friends
 * in utils/statusTranslations already return a semantic tone; every consumer
 * used to re-map that tone to Tailwind classes with its own switch statement,
 * which is why the same order status rendered in different colours on
 * different screens.
 */
const TONE_CLASS: Record<BadgeTone, string> = {
  success: "bg-green-50 text-green-700 ring-green-600/20",
  warning: "bg-amber-50 text-amber-700 ring-amber-600/20",
  danger: "bg-red-50 text-red-700 ring-red-600/20",
  info: "bg-blue-50 text-blue-700 ring-blue-600/20",
  neutral: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

export default function StatusBadge({
  label,
  tone = "neutral",
  size = "md",
  className,
}: {
  label: string;
  tone?: BadgeTone;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full shrink-0 items-center justify-center rounded-pill font-medium ring-1 ring-inset",
        size === "sm" ? "text-[11px] px-1.5 py-0.5" : "text-xs px-2 py-1",
        TONE_CLASS[tone],
        className,
      )}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}
