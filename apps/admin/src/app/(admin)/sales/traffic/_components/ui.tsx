/** Where a number comes from; data authority is part of the label, not a tooltip. */
export function SourceLabel({ source }: { source: "umami" | "commerce" }) {
  return (
    <span className="text-[11px] text-slate-500">
      {source === "commerce" ? "از سفارش‌های فروشگاه" : "از آمار بازدید (Umami)"}
    </span>
  );
}
