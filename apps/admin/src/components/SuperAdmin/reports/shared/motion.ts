"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Motion for the report pages: calm, short, and only where it explains a
 * change (something arrived, grew, or moved). Nothing loops, nothing runs
 * longer than a chart draw, and nothing moves once it has settled. Every
 * helper here stands still under `prefers-reduced-motion`, and also when the
 * preference cannot be read (tests, old browsers), so a missing signal never
 * means extra motion.
 */

export const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
export const DURATION = { micro: 160, standard: 280, count: 600, chart: 700 } as const;

/** Entrance for a section or card: a short fade up. Tailwind classes (tailwindcss-animate). */
export const ENTER = "animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out fill-mode-backwards motion-reduce:animate-none";
/** Entrance for a panel swapped in place (tabs, chart ↔ table). */
export const SWAP = "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out motion-reduce:animate-none";

function readReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** True when motion should be skipped, including when the preference is unknown. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

/**
 * False on the first paint, true one frame later: lets a mark transition in
 * from empty. Under reduced motion the `motion-reduce:` utilities skip the
 * transition, so the final state simply appears.
 */
export function useEntered() {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return entered;
}

/**
 * A number that glides to its new value: from zero on first show, then from
 * whatever it last showed when the value changes (a new date range). Returns
 * the value to render; callers keep the exact final value for screen readers.
 */
export function useCountUp(target: number | null, duration: number = DURATION.count): number | null {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState<number | null>(() => (reduced || target === null ? target : 0));
  // The last value painted, so a new target glides on from where the old one stood.
  const shownRef = useRef<number | null>(shown);

  useEffect(() => {
    const show = (value: number | null) => {
      shownRef.current = value;
      setShown(value);
    };
    if (reduced || target === null) {
      show(target);
      return;
    }
    const from = shownRef.current ?? 0;
    if (from === target) return;
    const started = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      // Ease-out cubic, close enough to EASE_OUT for numbers.
      const eased = 1 - (1 - progress) ** 3;
      show(progress >= 1 ? target : from + (target - from) * eased);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduced]);

  return shown;
}
