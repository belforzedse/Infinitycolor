"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { noteEnhancementLoaded, useAdaptiveQuality } from "@/lib/adaptive-quality";

// These timings intentionally preserve the product-rail transition that was
// used before the adaptive-quality rollout.
export const LEGACY_CAROUSEL_EXIT_MS = 150;
export const LEGACY_CAROUSEL_ENTER_DELAY_MS = 50;

type AdaptiveCarouselTransition = {
  isAnimating: boolean;
  richTransition: boolean;
  transitionTo: (page: number) => boolean;
  cancelTransition: (commitPending?: boolean) => void;
};

export function useAdaptiveCarouselTransition(
  setPage: Dispatch<SetStateAction<number>>,
): AdaptiveCarouselTransition {
  const quality = useAdaptiveQuality();
  const richTransition = quality.rendering === "enhanced" && quality.motion === "enhanced";
  const [isAnimating, setIsAnimating] = useState(false);
  const isAnimatingRef = useRef(false);
  const pendingPageRef = useRef<number | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (exitTimerRef.current !== null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (enterTimerRef.current !== null) {
      clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }
  }, []);

  const cancelTransition = useCallback(
    (commitPending = false) => {
      const pendingPage = pendingPageRef.current;
      const hadActiveTransition =
        isAnimatingRef.current ||
        pendingPage !== null ||
        exitTimerRef.current !== null ||
        enterTimerRef.current !== null;

      clearTimers();
      pendingPageRef.current = null;
      isAnimatingRef.current = false;

      if (commitPending && pendingPage !== null) {
        setPage(pendingPage);
      }
      if (hadActiveTransition) {
        setIsAnimating(false);
      }
    },
    [clearTimers, setPage],
  );

  useEffect(() => {
    if (!richTransition) {
      // A downgrade must never strand the requested page behind a decorative
      // transition. Commit it immediately and remove all pending animation work.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      cancelTransition(true);
    }
  }, [cancelTransition, richTransition]);

  useEffect(() => {
    if (!richTransition) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        cancelTransition(true);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [cancelTransition, richTransition]);

  useEffect(
    () => () => {
      clearTimers();
      pendingPageRef.current = null;
      isAnimatingRef.current = false;
    },
    [clearTimers],
  );

  const transitionTo = useCallback(
    (page: number) => {
      if (!richTransition) {
        cancelTransition(false);
        setPage(page);
        return true;
      }
      if (isAnimatingRef.current) return false;

      noteEnhancementLoaded("carousel-motion");
      pendingPageRef.current = page;
      isAnimatingRef.current = true;
      setIsAnimating(true);

      exitTimerRef.current = setTimeout(() => {
        exitTimerRef.current = null;
        const pendingPage = pendingPageRef.current;
        pendingPageRef.current = null;
        if (pendingPage !== null) {
          setPage(pendingPage);
        }

        enterTimerRef.current = setTimeout(() => {
          enterTimerRef.current = null;
          isAnimatingRef.current = false;
          setIsAnimating(false);
        }, LEGACY_CAROUSEL_ENTER_DELAY_MS);
      }, LEGACY_CAROUSEL_EXIT_MS);

      return true;
    },
    [cancelTransition, richTransition, setPage],
  );

  return {
    isAnimating,
    richTransition,
    transitionTo,
    cancelTransition,
  };
}
