"use client";

import Modal from "@/components/Kits/Modal";
import type { ReactNode } from "react";

interface ConfirmDialogProps {
  isOpen: boolean;
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmDisabled?: boolean;
  /**
   * "danger" paints the confirm button destructively. Previously every dialog —
   * including permanent deletion — used the same primary button, so nothing in
   * the UI distinguished an irreversible action from a routine one.
   */
  variant?: "default" | "danger";
  children?: ReactNode;
}

export default function ConfirmDialog({
  isOpen,
  title = "تأیید عملیات",
  description,
  confirmText = "تأیید",
  cancelText = "انصراف",
  onConfirm,
  onCancel,
  confirmDisabled = false,
  variant = "default",
  children,
}: ConfirmDialogProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      className="max-w-md"
    >
      <div className="flex flex-col gap-6">
        {description ? (
          <p className="text-sm text-right text-neutral-600">{description}</p>
        ) : null}
        {children}

        <div className="flex items-center justify-start gap-3">
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={`rounded-control px-5 py-2.5 text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 ${
              variant === "danger" ? "bg-red-600" : "bg-actions-primary"
            }`}
          >
            {confirmText}
          </button>
          {cancelText && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-control border border-slate-200 px-5 py-2.5 text-neutral-700 hover:bg-slate-50"
            >
              {cancelText}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
