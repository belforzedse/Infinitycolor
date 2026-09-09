import Link from "next/link";
import clsx from "clsx";

type Props = {
  variant: "primary" | "secondary";
  icon: React.ReactNode;
  onClick?: () => void;
  text?: string;
  path?: string;
  disabled?: boolean;
  testId?: string;
  /** Accessible name for icon-only actions. */
  ariaLabel?: string;
  title?: string;
  dataAttributes?: Record<string, string | number | boolean | undefined>;
};

export default function SuperAdminTableCellActionButton(props: Props) {
  const { variant, icon, onClick, text, path, disabled, testId, ariaLabel, title, dataAttributes } =
    props;
  const testAttributes = {
    ...(testId ? { "data-testid": testId } : {}),
    ...(dataAttributes
      ? Object.fromEntries(
          Object.entries(dataAttributes)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [`data-${key}`, String(value)]),
        )
      : {}),
  };

  const className = clsx(
    "flex h-[26px] items-center justify-center gap-1 rounded-md px-2 transition-all",
    text ? "w-auto" : "w-[25px] px-0",
    disabled
      ? "cursor-not-allowed opacity-50"
      : variant === "primary"
        ? "bg-actions-primary hover:bg-actions-primary/80"
        : "bg-slate-200 hover:bg-slate-300",
  );

  if (path && !disabled) {
    return (
      <Link
        className={className}
        href={path}
        onClick={onClick}
        aria-label={ariaLabel}
        title={title ?? ariaLabel}
        {...testAttributes}
      >
        {icon}
        {text && <span className="text-xs text-slate-500">{text}</span>}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      {...testAttributes}
    >
      {icon}
      {text && <span className="text-xs text-slate-500">{text}</span>}
    </button>
  );
}
