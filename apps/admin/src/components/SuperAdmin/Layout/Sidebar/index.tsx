"use client";

import superAdminSidebar, {
  getSidebarItemsForCapabilities,
  type SidebarItem as SuperAdminSidebarItem,
} from "@/constants/superAdminSidebar";
import Link from "next/link";
import ChevronDownIcon from "../Icons/ChevronDownIcon";
import React, { useState, Fragment, useEffect, useMemo } from "react";
import clsx from "clsx";
import ExitIcon from "../Icons/ExitIcon";
import { usePathname, useRouter } from "next/navigation";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import { performLogout } from "@/utils/logout";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Dialog, Transition } from "@headlessui/react";

interface SuperAdminLayoutSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Only true in the mobile ClientLayout; avoids an open Headless Dialog trap on tablet/desktop */
  enableMobileDrawer?: boolean;
}

type SidebarNavProps = {
  sidebarItems: SuperAdminSidebarItem[];
  openMenus: Record<string, boolean>;
  setOpenMenus: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  isCollapsed: boolean;
  onToggleCollapse?: () => void;
  onNavigate?: () => void;
  variant: "mobile" | "desktop";
};

function activeEdgeClass(variant: "mobile" | "desktop", heightClass: string): string {
  if (variant === "mobile") {
    return `pointer-events-none absolute left-0 top-1/2 ${heightClass} w-2 -translate-y-1/2 rounded-l-full`;
  }
  return `pointer-events-none absolute right-0 top-1/2 ${heightClass} w-1.5 -translate-y-1/2 rounded-l-full`;
}

function SidebarNav({
  sidebarItems,
  openMenus,
  setOpenMenus,
  isCollapsed,
  onToggleCollapse,
  onNavigate,
  variant,
}: SidebarNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const showLabels = variant === "mobile" || !isCollapsed;

  const handleLogout = () => {
    performLogout();
  };

  const openConfirm = () => setShowConfirm(true);
  const closeConfirm = () => setShowConfirm(false);

  const openAndNavigate = (item: (typeof superAdminSidebar)[number]) => {
    if (item.href) {
      router.push(item.href);
      onNavigate?.();
    }
    if (item.children.length > 0) {
      setOpenMenus((p) => ({ ...p, [item.id]: true }));
    }
  };

  const handleParentClick = (item: (typeof superAdminSidebar)[number]) => {
    if (isCollapsed && onToggleCollapse) {
      onToggleCollapse();
      if (item.href) {
        const href = item.href;
        setTimeout(() => {
          router.push(href);
          onNavigate?.();
        }, 100);
      } else if (item.children.length > 0) {
        setOpenMenus((p) => ({
          ...p,
          [item.id]: !p[item.id],
        }));
      }
      return;
    }
    openAndNavigate(item);
  };

  const menuItems = (
    <div className="flex flex-col gap-2.5">
      {sidebarItems.map((item) => {
        const hasChildren = item.children.length > 0;
        const isOpenMenu = !!openMenus[item.id];
        const curr = pathname.replace(/\/$/, "");
        const itemBase = (item.href ?? "").replace(/\/$/, "");
        const hasActiveChild = item.children.some((child) => {
          const childHref = (child.href ?? "").replace(/\/$/, "");
          return childHref && (curr === childHref || curr.startsWith(childHref + "/"));
        });
        const isDashboardItem = item.id === "dashboard";
        const isActiveBase =
          itemBase &&
          (curr === itemBase ||
            curr === `${itemBase}/` ||
            (!isDashboardItem && curr.startsWith(itemBase + "/")));
        const isActive = Boolean(isActiveBase) || hasActiveChild;

        if (!hasChildren) {
          return (
            <Link
              key={item.id}
              href={item.href ? item.href : ""}
              data-testid="super-admin-sidebar-item"
              data-sidebar-id={item.id}
              data-sidebar-href={item.href ?? ""}
              onClick={() => onNavigate?.()}
              className={clsx(
                "relative flex min-h-11 items-center justify-between rounded-xl border px-3 py-2.5 transition-all duration-150",
                "focus-visible:ring-2 focus-visible:ring-infinity-primary/30",
                isActive
                  ? "border-infinity-primary-lighter/30 bg-infinity-primary-lighter/20 text-infinity-primary shadow-sm"
                  : "border-transparent text-neutral-600 hover:border-neutral-100 hover:bg-neutral-50",
                isCollapsed && variant === "desktop" && "md:justify-center md:px-2",
              )}
              title={isCollapsed && variant === "desktop" ? item.label : undefined}
            >
              {isActive && showLabels && (
                <span
                  className={clsx(
                    activeEdgeClass(variant, "h-10"),
                    "bg-gradient-to-b from-infinity-primary to-infinity-primary-light",
                  )}
                />
              )}
              <div
                className={clsx(
                  "flex min-w-0 w-full items-center gap-2.5",
                  isCollapsed && variant === "desktop" && "md:justify-center md:gap-0",
                )}
              >
                {item.icon}
                {showLabels && <span className="text-sm font-medium leading-6">{item.label}</span>}
              </div>
            </Link>
          );
        }

        return (
          <div key={item.id} className="flex flex-col">
            <div
              role="button"
              tabIndex={0}
              data-testid="super-admin-sidebar-item"
              data-sidebar-id={item.id}
              data-sidebar-href={item.href ?? ""}
              className={clsx(
                "relative flex min-h-11 items-center justify-between rounded-xl border px-3 py-2.5",
                "cursor-pointer transition-all duration-150 focus-visible:ring-2 focus-visible:ring-infinity-primary/30",
                isActive && showLabels
                  ? "border-infinity-primary-lighter/30 bg-infinity-primary-lighter/20 text-infinity-primary shadow-sm"
                  : "border-transparent hover:border-neutral-100 hover:bg-neutral-50",
                !isActive && "text-neutral-600",
                isCollapsed && variant === "desktop" && "md:justify-center md:px-2",
              )}
              onClick={() => handleParentClick(item)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleParentClick(item);
                }
              }}
              title={isCollapsed && variant === "desktop" ? item.label : undefined}
            >
              <div
                className={clsx(
                  "flex min-w-0 items-center gap-2.5",
                  isCollapsed && variant === "desktop" && "md:justify-center md:gap-0",
                )}
              >
                {item.icon}
                {showLabels && (
                  <span
                    className={clsx(
                      "text-sm font-medium",
                      "leading-6",
                      isActive ? "text-infinity-primary" : "text-neutral-600",
                    )}
                  >
                    {item.label}
                  </span>
                )}
              </div>
              {isActive && showLabels && (
                <span
                  className={clsx(
                    activeEdgeClass(variant, "h-10"),
                    "bg-gradient-to-b from-infinity-primary to-infinity-primary-light",
                  )}
                />
              )}

              {showLabels && (
                <div
                  role="button"
                  tabIndex={0}
                  className={clsx(
                    "rounded-md p-1 transition-transform duration-200",
                    "transition-colors duration-150 hover:bg-neutral-50",
                    isOpenMenu && "rotate-180",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenus((p) => ({
                      ...p,
                      [item.id]: !p[item.id],
                    }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      setOpenMenus((p) => ({
                        ...p,
                        [item.id]: !p[item.id],
                      }));
                    }
                  }}
                  aria-expanded={isOpenMenu}
                  aria-controls={`submenu-${item.id}`}
                >
                  <ChevronDownIcon />
                </div>
              )}
            </div>

            {hasChildren && isOpenMenu && showLabels && (
              <div
                className="mt-1 overflow-hidden rounded-2xl border border-neutral-200/70 bg-neutral-50/80 p-1 shadow-sm shadow-neutral-200/30"
                id={`submenu-${item.id}`}
              >
                {item.children.map((child, index) => {
                  const childPath = pathname.replace(/\/$/, "");
                  const href = (child.href ?? "").replace(/\/$/, "");
                  const active = !!href && (childPath === href || childPath.startsWith(href + "/"));
                  return (
                    <Fragment key={child.id}>
                      <Link
                        href={child.href}
                        data-testid="super-admin-sidebar-child"
                        data-sidebar-id={child.id}
                        data-sidebar-href={child.href}
                        onClick={(e) => {
                          e.stopPropagation();
                          onNavigate?.();
                        }}
                        className={clsx(
                          "text-sm relative block rounded-xl px-4 py-2.5 leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary",
                          "transition-colors duration-150",
                          "pl-6 pr-3",
                          active
                            ? "bg-neutral-100 font-medium text-neutral-900"
                            : "text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900",
                        )}
                      >
                        {child.label}
                        {active && (
                          <span
                            className={clsx(activeEdgeClass(variant, "h-8"), "bg-infinity-primary")}
                          />
                        )}
                      </Link>
                      {index !== item.children.length - 1 && (
                        <div className="mx-3 h-px bg-neutral-200/60" />
                      )}
                    </Fragment>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const logoutSection = (
    <>
      <div className="h-px w-full shrink-0 bg-neutral-100" />
      <div
        className={clsx(
          "flex shrink-0 cursor-pointer items-center px-2 py-1.5",
          isCollapsed && variant === "desktop" && "md:justify-center md:px-2",
        )}
      >
        <button
          type="button"
          onClick={openConfirm}
          className={clsx(
            "flex items-center gap-2",
            isCollapsed && variant === "desktop" && "md:justify-center md:gap-0",
          )}
          title={isCollapsed && variant === "desktop" ? "خروج" : undefined}
        >
          <ExitIcon />
          {showLabels && <span className="text-sm font-medium text-neutral-600">خروج</span>}
        </button>
        <ConfirmDialog
          isOpen={showConfirm}
          title="خروج از حساب کاربری"
          description="آیا از خروج از حساب کاربری خود مطمئن هستید؟"
          confirmText="بله، خارج شو"
          cancelText="انصراف"
          onConfirm={handleLogout}
          onCancel={closeConfirm}
        />
      </div>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="scrollbar-neutral min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-0.5">
        {menuItems}
      </div>
      {logoutSection}
    </div>
  );
}

type MobileDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  sidebarItems: SuperAdminSidebarItem[];
  openMenus: Record<string, boolean>;
  setOpenMenus: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
};

function SuperAdminMobileSidebarDrawer({
  isOpen,
  onClose,
  sidebarItems,
  openMenus,
  setOpenMenus,
}: MobileDrawerProps) {
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[1200]" onClose={onClose}>
        <div dir="ltr">
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" aria-hidden />
          </Transition.Child>

          <Transition.Child
            as={Fragment}
            enter="transform transition ease-out duration-300"
            enterFrom="translate-x-full"
            enterTo="translate-x-0"
            leave="transform transition ease-in duration-200"
            leaveFrom="translate-x-0"
            leaveTo="translate-x-full"
          >
            <Dialog.Panel
                dir="rtl"
                className="fixed right-0 top-0 z-50 flex h-dvh w-[300px] max-w-[88vw] flex-col overflow-hidden border-l border-neutral-100 bg-white shadow-2xl"
                style={{
                  paddingBottom: "env(safe-area-inset-bottom)",
                }}
              >
                <header
                  className="flex shrink-0 items-center justify-between border-b border-neutral-100 px-4 py-3"
                  style={{
                    paddingTop: "max(0.75rem, env(safe-area-inset-top))",
                  }}
                >
                  <span className="text-sm font-semibold text-neutral-700">منوی مدیریت</span>
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-full p-2 text-neutral-600 transition-colors hover:bg-neutral-100"
                    aria-label="بستن منو"
                  >
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      aria-hidden
                    >
                      <path
                        d="M6 18L18 6M6 6L18 18"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </header>

                <nav className="flex min-h-0 flex-1 flex-col p-3" aria-label="منوی مدیریت">
                  <SidebarNav
                    sidebarItems={sidebarItems}
                    openMenus={openMenus}
                    setOpenMenus={setOpenMenus}
                    isCollapsed={false}
                    onNavigate={onClose}
                    variant="mobile"
                  />
                </nav>
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition>
  );
}

export default function SuperAdminLayoutSidebar({
  isOpen,
  onClose,
  isCollapsed = false,
  onToggleCollapse,
  enableMobileDrawer = false,
}: SuperAdminLayoutSidebarProps) {
  const [openMenus, setOpenMenus] = useState<Record<string, boolean>>({});
  const pathname = usePathname();
  const { adminRole, capabilities } = useCurrentUser();
  const sidebarItems = useMemo(
    () => getSidebarItemsForCapabilities(capabilities, adminRole),
    [adminRole, capabilities],
  );

  useEffect(() => {
    const next: Record<string, boolean> = {};
    const curr = pathname.replace(/\/$/, "");
    sidebarItems.forEach((it) => {
      const base = (it.href ?? "").replace(/\/$/, "");
      if (it.children.length > 0 && base && (curr === base || curr.startsWith(base + "/"))) {
        next[it.id] = true;
      }
    });
    setOpenMenus((p) => ({ ...p, ...next }));
  }, [pathname, sidebarItems]);

  return (
    <>
      {enableMobileDrawer && (
        <SuperAdminMobileSidebarDrawer
          isOpen={isOpen}
          onClose={onClose}
          sidebarItems={sidebarItems}
          openMenus={openMenus}
          setOpenMenus={setOpenMenus}
        />
      )}

      <div
        id="sidebar"
        className={clsx(
          "relative hidden md:flex md:flex-col",
          "md:static md:z-auto lg:static lg:z-auto",
          "h-full w-full overflow-hidden transition-all duration-300 ease-in-out",
          isCollapsed
            ? "md:w-[80px] lg:w-[80px]"
            : "md:w-[288px] lg:w-[288px] xl:w-[304px]",
          "rounded-bl-2xl rounded-tl-2xl border-l border-neutral-100 bg-white shadow-[0_18px_50px_rgba(15,23,42,0.04)]",
        )}
      >
        <div
          className={clsx(
            "flex h-14 shrink-0 items-center border-b border-neutral-100/80 px-3",
            isCollapsed ? "justify-center" : "justify-between",
          )}
        >
          {!isCollapsed && (
            <span className="pr-1 text-xs font-semibold tracking-wide text-neutral-500">منوی مدیریت</span>
          )}
          {onToggleCollapse && (
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-600 shadow-sm transition-colors hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-800"
              onClick={onToggleCollapse}
              aria-label={isCollapsed ? "باز کردن منوی کناری" : "بستن منوی کناری"}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className={clsx("transition-transform duration-200", isCollapsed ? "" : "rotate-180")}
                aria-hidden
              >
                <path
                  d="M9 18L15 12L9 6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>

        <div
          className={clsx(
            "flex min-h-0 flex-1 flex-col gap-3 bg-white p-3 pt-3",
            "md:sticky md:top-0 lg:sticky lg:top-0",
          )}
        >
          <SidebarNav
            sidebarItems={sidebarItems}
            openMenus={openMenus}
            setOpenMenus={setOpenMenus}
            isCollapsed={isCollapsed}
            onToggleCollapse={onToggleCollapse}
            variant="desktop"
          />
        </div>
      </div>
    </>
  );
}
