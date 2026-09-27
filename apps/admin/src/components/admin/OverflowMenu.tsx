"use client";

import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { MoreVertical } from "lucide-react";
import Link from "next/link";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING, ICON_BUTTON } from "./tokens";

export type OverflowAction = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onSelect?: () => void;
  href?: string;
  disabled?: boolean;
  /** Renders in red and is separated from the routine actions above it. */
  destructive?: boolean;
  /** `data-testid` (plus `data-*` extras) for end-to-end selectors. */
  testId?: string;
  dataAttributes?: Record<string, string | number>;
};

function dataProps(testId?: string, dataAttributes?: Record<string, string | number>) {
  return {
    ...(testId ? { "data-testid": testId } : {}),
    ...Object.fromEntries(
      Object.entries(dataAttributes || {}).map(([key, value]) => [`data-${key}`, String(value)]),
    ),
  };
}

/**
 * Home for rare, secondary, destructive and administrative actions.
 *
 * The alternative — giving every action equal prominence in a row of buttons —
 * is how the order detail screen ended up leading with "cancel order" (which
 * refunds and restocks) as one of the first controls a phone user sees.
 */
export default function OverflowMenu({
  actions,
  label = "عملیات بیشتر",
  align = "end",
  className,
  triggerTestId,
  triggerDataAttributes,
}: {
  actions: OverflowAction[];
  label?: string;
  align?: "start" | "end";
  className?: string;
  triggerTestId?: string;
  triggerDataAttributes?: Record<string, string | number>;
}) {
  const visible = actions.filter(Boolean);
  if (visible.length === 0) return null;

  const routine = visible.filter((action) => !action.destructive);
  const destructive = visible.filter((action) => action.destructive);

  const renderItem = (action: OverflowAction) => {
    const itemClass = (focus: boolean) =>
      cn(
        "text-sm flex min-h-[44px] w-full items-center gap-2.5 px-3 text-right transition-colors md:min-h-[40px]",
        action.destructive ? "text-red-600" : "text-slate-700",
        focus && (action.destructive ? "bg-red-50" : "bg-slate-50"),
        action.disabled && "cursor-not-allowed opacity-50",
      );

    return (
      <MenuItem key={action.id} disabled={action.disabled}>
        {({ focus }) =>
          action.href && !action.disabled ? (
            <Link
              href={action.href}
              className={itemClass(focus)}
              {...dataProps(action.testId, action.dataAttributes)}
            >
              {action.icon}
              <span className="min-w-0 break-words">{action.label}</span>
            </Link>
          ) : (
            <button
              type="button"
              disabled={action.disabled}
              onClick={action.onSelect}
              className={itemClass(focus)}
              {...dataProps(action.testId, action.dataAttributes)}
            >
              {action.icon}
              <span className="min-w-0 break-words">{action.label}</span>
            </button>
          )
        }
      </MenuItem>
    );
  };

  return (
    <Menu as="div" className={cn("relative", className)}>
      <MenuButton
        aria-label={label}
        {...dataProps(triggerTestId, triggerDataAttributes)}
        className={cn(
          ICON_BUTTON,
          FOCUS_RING,
          "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
        )}
      >
        <MoreVertical className="h-5 w-5" aria-hidden />
      </MenuButton>
      <MenuItems
        // Anchored and portalled, so a menu opened inside a scrolling table or a
        // clipped card is never cut off. Floating UI reads the menu's RTL
        // direction: `end` lines the menu's left edge up with the trigger's, the
        // placement the old `left-0` gave.
        anchor={align === "end" ? "bottom end" : "bottom start"}
        className="z-50 w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg [--anchor-gap:8px] focus:outline-none"
        dir="rtl"
      >
        {routine.map(renderItem)}
        {routine.length > 0 && destructive.length > 0 && (
          <div className="my-1 h-px bg-slate-100" role="separator" />
        )}
        {destructive.map(renderItem)}
      </MenuItems>
    </Menu>
  );
}
