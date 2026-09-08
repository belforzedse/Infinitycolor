"use client";

import { useEffect, type RefObject } from "react";

/**
 * Closes a popup when the pointer goes down outside it or Escape is pressed.
 *
 * Several admin dropdowns were hand-rolled around a bare `useState`, so they
 * stayed open until the trigger was clicked again — the reported behaviour of
 * the product bulk-action menu. Each place that needed dismissal reimplemented
 * its own listener (or an invisible full-screen overlay); this is the one
 * implementation they can share.
 */
export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && ref.current && !ref.current.contains(target)) {
        onDismiss();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, isOpen, onDismiss]);
}

export default useDismissOnOutside;
