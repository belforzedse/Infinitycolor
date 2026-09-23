"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * "Exactly one video plays": a page-wide coordinator over IntersectionObserver.
 *
 *   active — the most-visible registered element with at least `threshold` of its area on
 *            screen, while the tab is visible. At most one per coordinator.
 *   near   — within one viewport of the screen: worth preparing (poster decoded, warm).
 *   idle   — everything else, and everything while the tab is hidden.
 *
 * Elements hidden with CSS (`display: none` duplicate layouts) never intersect, so they
 * are never active — which is what keeps a responsive page that renders both a mobile and
 * a desktop tree from playing two copies.
 */

export type VisibilitySlot = "active" | "near" | "idle";

interface Member {
  ratio: number;
  near: boolean;
  slot: VisibilitySlot;
  notify: (slot: VisibilitySlot) => void;
}

class VisibilityCoordinator {
  private readonly members = new Map<Element, Member>();
  private visibleObserver: IntersectionObserver | null = null;
  private nearObserver: IntersectionObserver | null = null;
  private readonly onVisibility = () => this.recompute();

  constructor(private readonly threshold: number) {}

  observe(element: Element, notify: (slot: VisibilitySlot) => void): () => void {
    if (typeof IntersectionObserver === "undefined") {
      // No observer (very old browser, or a test DOM): treat the element as visible and
      // leave the choice to the caller's own active-item logic.
      notify("active");
      return () => undefined;
    }
    if (!this.visibleObserver) {
      this.visibleObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const member = this.members.get(entry.target);
            if (member) member.ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
          }
          this.recompute();
        },
        { threshold: [0, 0.25, 0.5, 0.6, 0.75, 0.9, 1] },
      );
      this.nearObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const member = this.members.get(entry.target);
            if (member) member.near = entry.isIntersecting;
          }
          this.recompute();
        },
        { rootMargin: "100% 100%" },
      );
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    this.members.set(element, { ratio: 0, near: false, slot: "idle", notify });
    this.visibleObserver.observe(element);
    this.nearObserver!.observe(element);
    return () => {
      this.members.delete(element);
      this.visibleObserver?.unobserve(element);
      this.nearObserver?.unobserve(element);
      if (this.members.size === 0) this.teardown();
      else this.recompute();
    };
  }

  private teardown(): void {
    this.visibleObserver?.disconnect();
    this.nearObserver?.disconnect();
    this.visibleObserver = null;
    this.nearObserver = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private recompute(): void {
    const hidden = document.visibilityState === "hidden";
    let best: Element | null = null;
    let bestRatio = 0;
    if (!hidden) {
      for (const [element, member] of this.members) {
        if (member.ratio >= this.threshold && member.ratio > bestRatio) {
          best = element;
          bestRatio = member.ratio;
        }
      }
    }
    for (const [element, member] of this.members) {
      const slot: VisibilitySlot = element === best ? "active" : !hidden && member.near ? "near" : "idle";
      if (slot !== member.slot) {
        member.slot = slot;
        member.notify(slot);
      }
    }
  }
}

const coordinators = new Map<number, VisibilityCoordinator>();

function coordinatorFor(threshold: number): VisibilityCoordinator {
  let coordinator = coordinators.get(threshold);
  if (!coordinator) {
    coordinator = new VisibilityCoordinator(threshold);
    coordinators.set(threshold, coordinator);
  }
  return coordinator;
}

export function useVisibilitySlot(
  ref: RefObject<Element | null>,
  { threshold = 0.6, enabled = true }: { threshold?: number; enabled?: boolean } = {},
): VisibilitySlot {
  const [slot, setSlot] = useState<VisibilitySlot>("idle");
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) {
      setSlot("idle");
      return;
    }
    const stop = coordinatorFor(threshold).observe(element, setSlot);
    return () => {
      stop();
      setSlot("idle");
    };
  }, [ref, threshold, enabled]);
  return slot;
}
