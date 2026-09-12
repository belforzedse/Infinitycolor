"use client";

import Link from "next/link";
import { USER_SIDEBAR_ITEMS, LOGOUT_ITEM } from "@/components/User/Constnats";
import { isValidElement, cloneElement, useState } from "react";
import type { ReactElement } from "react";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import { performLogout } from "@/utils/logout";

const enhanceIcon = (icon: ReactElement<any>, className: string) =>
  cloneElement(icon, { className });

const TILE_CLASS =
  "group flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-right shadow-sm transition-colors hover:border-infinity-primary-lighter/60 hover:shadow-md";

export default function AccountQuickLinks() {
  const [showConfirm, setShowConfirm] = useState(false);

  const logoutIcon = isValidElement(LOGOUT_ITEM.icon)
    ? enhanceIcon(LOGOUT_ITEM.icon as ReactElement, "h-5 w-5 shrink-0 text-red-500")
    : LOGOUT_ITEM.icon;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:hidden">
        {USER_SIDEBAR_ITEMS.map((item) => {
          const icon =
            isValidElement(item.icon) && item.icon
              ? enhanceIcon(item.icon as ReactElement, "h-5 w-5 shrink-0 text-infinity-primary")
              : item.icon;

          return (
            <Link key={item.href} href={item.href} className={TILE_CLASS}>
              <div className="flex flex-col">
                <span className="text-xs font-medium text-slate-500">{item.text}</span>

              </div>
              {icon}
            </Link>
          );
        })}

        {/* Logout is deliberately not part of USER_SIDEBAR_ITEMS: the sidebar and the
            mobile hamburger menu each append it themselves, so adding it to the shared
            array would render it twice there. */}
        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          className={`${TILE_CLASS} hover:border-red-200`}
        >
          <div className="flex flex-col">
            <span className="text-xs font-medium text-red-500">{LOGOUT_ITEM.text}</span>
          </div>
          {logoutIcon}
        </button>
      </div>

      <ConfirmDialog
        isOpen={showConfirm}
        title="خروج از حساب کاربری"
        description="آیا از خروج از حساب کاربری خود مطمئن هستید؟"
        confirmText="بله، خارج شو"
        cancelText="انصراف"
        onConfirm={() => performLogout()}
        onCancel={() => setShowConfirm(false)}
      />
    </>
  );
}
