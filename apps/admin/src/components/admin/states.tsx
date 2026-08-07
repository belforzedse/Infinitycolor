"use client";

import Link from "next/link";
import {
  AlertTriangle,
  Inbox,
  Loader2,
  Lock,
  RefreshCw,
  SearchX,
  FileQuestion,
} from "lucide-react";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING, TOUCH_TARGET } from "./tokens";

type Action = {
  label: string;
  onClick?: () => void;
  href?: string;
};

function ActionButton({
  action,
  variant = "primary",
}: {
  action: Action;
  variant?: "primary" | "ghost";
}) {
  const className = cn(
    "text-sm inline-flex items-center justify-center gap-2 rounded-lg px-4 font-medium",
    TOUCH_TARGET,
    FOCUS_RING,
    variant === "primary"
      ? "bg-infinity-primary text-white hover:bg-infinity-primary-dark"
      : "border border-slate-200 text-slate-700 hover:bg-slate-50",
  );

  if (action.href) {
    return (
      <Link href={action.href} className={className}>
        {action.label}
      </Link>
    );
  }

  return (
    <button type="button" onClick={action.onClick} className={className}>
      {action.label}
    </button>
  );
}

/**
 * The shared shell behind every non-content state. Sizing is deliberately
 * modest — these render inside a card that already has padding, so a full
 * hero-sized empty state would push real content off a phone screen.
 */
function StateShell({
  icon,
  title,
  description,
  tone = "neutral",
  primaryAction,
  secondaryAction,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  tone?: "neutral" | "danger";
  primaryAction?: Action;
  secondaryAction?: Action;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-4 py-10 text-center md:py-14",
        className,
      )}
      dir="rtl"
    >
      <div
        className={cn(
          "mb-3 flex h-12 w-12 items-center justify-center rounded-full",
          tone === "danger"
            ? "bg-red-50 text-red-500"
            : "bg-slate-100 text-slate-400",
        )}
        aria-hidden
      >
        {icon}
      </div>
      <p className="text-base font-medium text-slate-700">{title}</p>
      {description && (
        <p className="text-sm mt-1 max-w-sm text-balance text-slate-500">
          {description}
        </p>
      )}
      {(primaryAction || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {primaryAction && <ActionButton action={primaryAction} />}
          {secondaryAction && (
            <ActionButton action={secondaryAction} variant="ghost" />
          )}
        </div>
      )}
    </div>
  );
}

/** The resource genuinely contains nothing yet. */
export function EmptyState({
  title = "هنوز موردی ثبت نشده است",
  description,
  action,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  action?: Action;
  className?: string;
}) {
  return (
    <StateShell
      icon={<Inbox className="h-6 w-6" />}
      title={title}
      description={description}
      primaryAction={action}
      className={className}
    />
  );
}

/**
 * Records exist but the current search/filter matched none. Distinct from
 * EmptyState because the useful action here is clearing the filter, not
 * creating a record.
 */
export function FilteredEmptyState({
  title = "موردی با این جستجو پیدا نشد",
  description = "عبارت جستجو یا فیلترهای اعمال‌شده را تغییر دهید.",
  onClearFilters,
  clearLabel = "حذف فیلترها",
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  onClearFilters?: () => void;
  clearLabel?: string;
  className?: string;
}) {
  return (
    <StateShell
      icon={<SearchX className="h-6 w-6" />}
      title={title}
      description={description}
      primaryAction={
        onClearFilters
          ? { label: clearLabel, onClick: onClearFilters }
          : undefined
      }
      className={className}
    />
  );
}

/** Data should exist but could not be loaded. Always offers a retry. */
export function ErrorState({
  title = "بارگذاری اطلاعات ناموفق بود",
  description,
  onRetry,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <StateShell
      icon={<AlertTriangle className="h-6 w-6" />}
      tone="danger"
      title={title}
      description={description}
      primaryAction={
        onRetry ? { label: "تلاش دوباره", onClick: onRetry } : undefined
      }
      className={className}
    />
  );
}

/** The signed-in role is not permitted to see this resource. */
export function PermissionState({
  title = "دسترسی به این بخش را ندارید",
  description = "برای مشاهده این بخش با مدیر سیستم تماس بگیرید.",
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  className?: string;
}) {
  return (
    <StateShell
      icon={<Lock className="h-6 w-6" />}
      title={title}
      description={description}
      primaryAction={{ label: "بازگشت به پیشخوان", href: "/" }}
      className={className}
    />
  );
}

/** The specific record does not exist. */
export function NotFoundState({
  title = "این مورد پیدا نشد",
  description = "ممکن است حذف شده باشد یا نشانی اشتباه باشد.",
  backHref,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  backHref?: string;
  className?: string;
}) {
  return (
    <StateShell
      icon={<FileQuestion className="h-6 w-6" />}
      title={title}
      description={description}
      primaryAction={backHref ? { label: "بازگشت", href: backHref } : undefined}
      className={className}
    />
  );
}

/**
 * Shown while a refresh is in flight over content that is already on screen —
 * the alternative to blanking the page on every filter change.
 */
export function InlineLoadingState({
  label = "در حال به‌روزرسانی…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-xs inline-flex items-center gap-2 text-slate-500",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

/**
 * Wraps content that is being refreshed: keeps it visible and readable but
 * clearly inert, instead of swapping it for a skeleton.
 */
export function RefreshingOverlay({
  isRefreshing,
  children,
  className,
}: {
  isRefreshing: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "transition-opacity duration-200",
          isRefreshing && "pointer-events-none opacity-60",
        )}
        aria-busy={isRefreshing}
      >
        {children}
      </div>
      {isRefreshing && (
        <div className="absolute inset-x-0 top-2 flex justify-center">
          <span className="text-xs inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/90 px-3 py-1 text-slate-600 shadow-sm backdrop-blur">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
            در حال به‌روزرسانی
          </span>
        </div>
      )}
    </div>
  );
}
