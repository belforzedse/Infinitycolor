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
  /**
   * A second "inside" region, e.g. a panel portaled to document.body so it can
   * escape an ancestor's overflow clipping — it's no longer a DOM descendant
   * of `ref`, so without this a click inside it reads as "outside" and closes
   * the panel before its own option handler fires.
   */
  extraRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (extraRef?.current?.contains(target)) return;
      onDismiss();
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
  }, [ref, isOpen, onDismiss, extraRef]);
}

export default useDismissOnOutside;
