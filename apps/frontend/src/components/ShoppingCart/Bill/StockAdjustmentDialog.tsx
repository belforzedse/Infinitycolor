"use client";

import React from "react";
import Modal from "@/components/Kits/Modal";
import { faNum } from "@/utils/faNum";

export interface StockAdjustedRow {
  name: string;
  requested: number;
  newQuantity: number;
}

export interface StockRemovedRow {
  name: string;
}

interface Props {
  isOpen: boolean;
  adjusted: StockAdjustedRow[];
  removed: StockRemovedRow[];
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting?: boolean;
}

/**
 * Shown when a checkout stock re-check changes the cart (reduced quantities or
 * removed items). The user must explicitly acknowledge the new state before the
 * order proceeds — replacing the previous silent toast that let an altered order
 * go through without review.
 */
export default function StockAdjustmentDialog({
  isOpen,
  adjusted,
  removed,
  onConfirm,
  onCancel,
  isSubmitting = false,
}: Props) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="تغییر در موجودی سبد خرید"
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4" data-testid="stock-adjustment-dialog">
        <p className="text-sm text-right text-neutral-600">
          به دلیل تغییر موجودی انبار، سبد خرید شما به‌روزرسانی شد. لطفاً تغییرات زیر را بررسی کنید
          و سپس ادامه دهید:
        </p>

        {adjusted.length > 0 && (
          <ul className="flex flex-col gap-2" data-testid="stock-adjusted-list">
            {adjusted.map((row, i) => (
              <li
                key={`adj-${i}`}
                className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-right text-amber-800"
              >
                <span className="font-medium">{row.name}</span>: تعداد از{" "}
                {faNum(row.requested)} به {faNum(row.newQuantity)} عدد کاهش یافت
              </li>
            ))}
          </ul>
        )}

        {removed.length > 0 && (
          <ul className="flex flex-col gap-2" data-testid="stock-removed-list">
            {removed.map((row, i) => (
              <li
                key={`rem-${i}`}
                className="rounded-lg bg-red-50 px-3 py-2 text-sm text-right text-red-700"
              >
                <span className="font-medium">{row.name}</span>: ناموجود شد و از سبد خرید حذف شد
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting}
            data-testid="stock-adjustment-confirm"
            className={
              "rounded-xl bg-infinity-primary px-5 py-2.5 text-white hover:brightness-110 " +
              (isSubmitting ? "cursor-not-allowed opacity-70" : "")
            }
          >
            {isSubmitting ? "در حال پردازش..." : "ادامه و پرداخت"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            data-testid="stock-adjustment-cancel"
            className="rounded-xl border border-slate-200 px-5 py-2.5 text-neutral-700 hover:bg-slate-50 disabled:opacity-50"
          >
            بازگشت به سبد خرید
          </button>
        </div>
      </div>
    </Modal>
  );
}
