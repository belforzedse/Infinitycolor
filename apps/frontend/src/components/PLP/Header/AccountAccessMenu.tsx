"use client";

import Link from "next/link";
import { UserCog } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import UserProfileIcon from "@/components/PLP/Icons/UserProfileIcon";
import { useCurrentUser } from "@/hooks/useCurrentUser";

type MenuPosition = "top" | "bottom";
type MenuAlign = "left" | "center" | "right";

interface AccountAccessMenuProps {
  triggerClassName: string;
  triggerContent?: ReactNode;
  triggerIconClassName?: string;
  triggerAriaLabel?: string;
  menuPosition?: MenuPosition;
  menuAlign?: MenuAlign;
  ariaCurrent?: "page";
  onNavigate?: () => void;
  onTriggerClick?: () => void;
}

const positionClassNames: Record<MenuPosition, string> = {
  top: "bottom-full mb-2",
  bottom: "top-full mt-2",
};

const alignClassNames: Record<MenuAlign, string> = {
  left: "left-0",
  center: "left-1/2 -translate-x-1/2",
  right: "right-0",
};

export default function AccountAccessMenu({
  triggerClassName,
  triggerContent,
  triggerIconClassName = "h-6 w-6",
  triggerAriaLabel = "Account",
  menuPosition = "bottom",
  menuAlign = "center",
  ariaCurrent,
  onNavigate,
  onTriggerClick,
}: AccountAccessMenuProps) {
  const { isAuthenticated, isAdmin, isLoading } = useCurrentUser();
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const canOpenAdminMenu = !isLoading && isAuthenticated && isAdmin;
  const fallbackHref = isAuthenticated ? "/account" : "/auth/login";
  const fallbackLabel = isAuthenticated ? "Account" : "Login";
  const content = triggerContent ?? <UserProfileIcon className={triggerIconClassName} />;

  useEffect(() => {
    if (!canOpenAdminMenu) {
      setIsOpen(false);
    }
  }, [canOpenAdminMenu]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const handleNavigate = () => {
    setIsOpen(false);
    onNavigate?.();
  };

  if (!canOpenAdminMenu) {
    return (
      <Link
        href={fallbackHref}
        aria-label={fallbackLabel}
        aria-current={ariaCurrent}
        onClick={onNavigate}
        className={triggerClassName}
      >
        {content}
      </Link>
    );
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={triggerAriaLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-current={ariaCurrent}
        onClick={() => {
          onTriggerClick?.();
          setIsOpen((current) => !current);
        }}
        className={triggerClassName}
      >
        {content}
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label="Account destinations"
          className={[
            "absolute z-[1500] flex w-11 flex-col items-center gap-1 rounded-full border border-stone-200 bg-white p-1 shadow-[0_10px_30px_rgba(15,23,42,0.18)]",
            positionClassNames[menuPosition],
            alignClassNames[menuAlign],
          ].join(" ")}
        >
          <Link
            href="/account"
            role="menuitem"
            aria-label="Account"
            title="Account"
            onClick={handleNavigate}
            className="pressable flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-stone-50 hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            <UserProfileIcon className="h-5 w-5" />
          </Link>
          <Link
            href="/super-admin"
            role="menuitem"
            aria-label="Super admin"
            title="Super admin"
            onClick={handleNavigate}
            className="pressable flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-stone-50 hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            <UserCog className="h-5 w-5" aria-hidden="true" />
          </Link>
        </div>
      )}
    </div>
  );
}
