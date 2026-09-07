import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

export interface AuthButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  fullWidth?: boolean;
  icon?: ReactNode;
  iconPosition?: "left" | "right";
  variant?: "primary" | "secondary";
}

export default function AuthButton({
  children,
  className,
  fullWidth = true,
  icon,
  iconPosition = "right",
  variant = "primary",
  ...props
}: AuthButtonProps) {
  const content = (
    <div className="flex items-center justify-center gap-1">
      {iconPosition === "left" && icon}
      {typeof children === "string" ? <span>{children}</span> : children}
      {iconPosition === "right" && icon}
    </div>
  );

  return (
    <button
      className={clsx(
        "btn px-3 text-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 aria-[busy=true]:cursor-wait aria-[busy=true]:select-none motion-reduce:transform-none motion-reduce:transition-none",
        variant === "primary"
          ? "min-h-[49px] rounded-prominent bg-infinity-primary text-white shadow-sm hover:bg-infinity-primary-dark hover:shadow-md hover:shadow-infinity-primary/20 active:scale-[0.97] active:bg-infinity-primary-darker disabled:bg-infinity-primary/50 disabled:shadow-none"
          : "min-h-12 rounded-control border border-infinity-primary bg-transparent text-infinity-primary shadow-none hover:bg-infinity-primary-lighter/20 active:bg-infinity-primary-lighter/30",
        fullWidth && "w-full",
        className,
      )}
      {...props}
    >
      {icon ? content : children}
    </button>
  );
}
