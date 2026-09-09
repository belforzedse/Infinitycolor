"use client";

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useId,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** Overrides the default `p-6` on the inner content wrapper. Pass `"p-0"` to let children control their own padding. */
  contentClassName?: string;
  title?: string;
  titleClassName?: string;
  closeIcon?: ReactNode;
  "aria-labelledby"?: string;
}

export default function Modal({
  isOpen,
  onClose,
  children,
  className = "",
  contentClassName,
  title,
  titleClassName = "",
  closeIcon,
  "aria-labelledby": ariaLabelledby,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const openedAtRef = useRef(0);
  const backdropPointerIdRef = useRef<number | null>(null);
  const [mounted, setMounted] = useState(false);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const BACKDROP_GUARD_MS = 600;
  const generatedTitleId = useId();
  const titleId = title ? generatedTitleId : undefined;
  const labelledById = title ? generatedTitleId : ariaLabelledby;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      backdropPointerIdRef.current = null;
      setSurfaceReady(false);
      return;
    }

    openedAtRef.current = Date.now();
    backdropPointerIdRef.current = null;
    setSurfaceReady(false);
    const timer = window.setTimeout(() => setSurfaceReady(true), BACKDROP_GUARD_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Esc" || e.keyCode === 27) {
        onClose();
      }
    },
    [onClose],
  );

  const getFocusableElements = useCallback(() => {
    if (!modalRef.current) return [];
    const selectors = [
      "a[href]",
      "area[href]",
      "input:not([disabled]):not([type='hidden'])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "button:not([disabled])",
      "iframe",
      "object",
      "embed",
      "[contenteditable]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    return Array.from(modalRef.current.querySelectorAll<HTMLElement>(selectors)).filter(
      (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
    );
  }, []);

  // Body scroll lock and initial focus
  useEffect(() => {
    if (isOpen && typeof window !== "undefined") {
      // Store previously focused element
      previousActiveElement.current = document.activeElement as HTMLElement;

      // Initial focus. On coarse pointers, skip the close button so a leftover
      // tap cannot activate it after the menu that opened this dialog unmounts.
      const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches === true;
      if (coarsePointer) {
        modalRef.current?.focus();
      } else {
        const focusableElements = getFocusableElements();
        if (focusableElements.length > 0) {
          focusableElements[0].focus();
        } else {
          modalRef.current?.focus();
        }
      }

      // Lock body scroll
      document.body.style.overflow = "hidden";

      return () => {
        // Restore focus
        if (previousActiveElement.current) {
          previousActiveElement.current.focus();
        }

        // Unlock body scroll
        document.body.style.overflow = "";
      };
    }
  }, [isOpen, getFocusableElements]);

  // Event listeners (Escape and Tab)
  useEffect(() => {
    if (isOpen && typeof window !== "undefined") {
      // Add Escape key listener
      window.addEventListener("keydown", handleEscape);

      const handleTabKey = (e: KeyboardEvent) => {
        if (e.key !== "Tab") return;
        const focusables = getFocusableElements();
        if (focusables.length === 0) {
          e.preventDefault();
          modalRef.current?.focus();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const activeElement = document.activeElement as HTMLElement | null;
        const isWithinModal = !!activeElement && !!modalRef.current?.contains(activeElement);

        if (!isWithinModal) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }

        if (e.shiftKey) {
          if (activeElement === first || activeElement === modalRef.current) {
            e.preventDefault();
            last.focus();
          }
          return;
        }

        if (activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      };

      document.addEventListener("keydown", handleTabKey);

      return () => {
        // Remove listeners
        window.removeEventListener("keydown", handleEscape);
        document.removeEventListener("keydown", handleTabKey);
      };
    }
  }, [isOpen, handleEscape, getFocusableElements]);

  // Handle click outside. Ignore leftover mobile taps: they arrive as a click
  // without a pointerdown on this overlay, often within ~300ms of open.
  const isBackdropGuardActive = () => Date.now() - openedAtRef.current < BACKDROP_GUARD_MS;

  const handleBackdropPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (isBackdropGuardActive() || e.target !== e.currentTarget) return;
    backdropPointerIdRef.current = e.pointerId;
  };

  const handleBackdropClick = (e: ReactMouseEvent | ReactKeyboardEvent) => {
    if (isBackdropGuardActive()) return;
    if (e.target !== e.currentTarget) return;
    if (backdropPointerIdRef.current === null) return;
    onClose();
  };

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[1600] flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm duration-200 animate-in fade-in",
        !surfaceReady && "pointer-events-none",
      )}
      onPointerDown={handleBackdropPointerDown}
      onClick={handleBackdropClick}
      tabIndex={-1}
    >
      <div
        ref={modalRef}
        className={cn(
          "relative w-full max-w-7xl rounded-panel bg-white shadow-2xl duration-200 animate-in zoom-in-95",
          className,
        )}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledById}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          {title && (
            <h3 id={titleId} className={`text-lg font-bold text-gray-900 ${titleClassName}`}>
              {title}
            </h3>
          )}

          <button
            type="button"
            onClick={onClose}
            className="group flex h-10 w-10 items-center justify-center rounded-pill bg-gray-50 transition-[background-color,box-shadow,transform] duration-150 ease-out hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 active:scale-95 motion-reduce:transform-none motion-reduce:transition-none"
            aria-label="بستن"
          >
            {closeIcon || (
              <svg
                className="h-6 w-6 text-gray-600 group-hover:text-gray-900"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            )}
          </button>
        </div>

        <div className={contentClassName ?? "p-6"}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
