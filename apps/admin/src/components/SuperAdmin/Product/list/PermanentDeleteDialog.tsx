"use client";

import { useState } from "react";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import { faNum } from "@/utils/faNum";
import { PERMANENT_DELETE_PHRASE } from "./productLifecycle";

/**
 * The strong confirmation for irreversible deletion. It names the product (or
 * states the count), says what survives — order history keeps the product —
 * and stays disabled until the operator types the confirmation phrase.
 */
export default function PermanentDeleteDialog({
  isOpen,
  productTitle,
  count,
  emptyTrash,
  busy,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  /** Set for a single product. */
  productTitle?: string;
  /** Number of products for a bulk deletion or Empty Trash. */
  count?: number;
  emptyTrash?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Mounted per request by the caller, so the phrase always starts empty.
  const [typed, setTyped] = useState("");

  const subject = productTitle
    ? `محصول «${productTitle}»`
    : emptyTrash
      ? `همهٔ ${faNum(count ?? 0)} محصول داخل سطل زباله`
      : `${faNum(count ?? 0)} محصول انتخاب‌شده`;
  const matches = typed.trim() === PERMANENT_DELETE_PHRASE;

  return (
    <ConfirmDialog
      isOpen={isOpen}
      variant="danger"
      title={emptyTrash ? "خالی کردن سطل زباله" : "حذف دائمی"}
      description={`${subject} برای همیشه حذف می‌شود و دیگر قابل بازیابی نیست. سفارش‌های قبلی، فاکتورها و گزارش‌ها اطلاعات این محصول را حفظ می‌کنند و کد SKU آن آزاد می‌شود.`}
      confirmText={busy ? "در حال حذف..." : "حذف برای همیشه"}
      confirmDisabled={!matches || busy}
      onConfirm={() => matches && onConfirm()}
      onCancel={onCancel}
    >
      <label className="block text-sm text-neutral-700" data-testid="admin-product-permanent-delete-dialog">
        برای تأیید، عبارت «{PERMANENT_DELETE_PHRASE}» را بنویسید:
        <input
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="mt-2 h-10 w-full rounded-lg border border-neutral-300 px-3 text-sm focus:border-red-400 focus:outline-none"
          autoComplete="off"
          aria-label="عبارت تأیید حذف دائمی"
        />
      </label>
    </ConfirmDialog>
  );
}
