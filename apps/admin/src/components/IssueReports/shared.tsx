import type { IssueReportStatus } from "@/services/issue-reports";

export const STATUS: Record<
  IssueReportStatus,
  { label: string; className: string }
> = {
  new: { label: "جدید", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  in_review: {
    label: "در حال بررسی",
    className: "bg-amber-50 text-amber-700 ring-amber-200",
  },
  resolved: {
    label: "رسیدگی‌شده",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
};

export function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function StatusBadge({ status }: { status: IssueReportStatus }) {
  const item = STATUS[status];
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${item.className}`}
    >
      {item.label}
    </span>
  );
}
