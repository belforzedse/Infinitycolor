"use client";

import toast from "react-hot-toast";

export const UNDO_TOAST_DURATION_MS = 8_000;

/**
 * "Moved to Trash — Undo". The button calls the real restore endpoint with the
 * trash token (see useProductLifecycleActions); it never just reverts screen
 * state. The server honours Undo for a short window only, so the toast does not
 * outlive it.
 */
export function showUndoToast({
  message,
  onUndo,
  undoLabel = "بازگردانی",
}: {
  message: string;
  onUndo: () => void | Promise<void>;
  undoLabel?: string;
}): string {
  return toast.custom(
    (t) => (
      <div
        role="status"
        dir="rtl"
        className={`flex max-w-[calc(100vw-2rem)] items-center gap-4 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-lg transition-opacity ${
          t.visible ? "opacity-100" : "opacity-0"
        }`}
        data-testid="admin-product-undo-toast"
      >
        <span className="min-w-0 break-words">{message}</span>
        <button
          type="button"
          className="shrink-0 rounded-lg px-2 py-1 font-semibold text-amber-300 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
          onClick={() => {
            toast.dismiss(t.id);
            void onUndo();
          }}
        >
          {undoLabel}
        </button>
      </div>
    ),
    { duration: UNDO_TOAST_DURATION_MS },
  );
}
