"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAdaptiveQuality } from "@/lib/adaptive-quality";

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void) => number;
  cancelIdleCallback?: (id: number) => void;
};

export default function ImageEffects() {
  const pathname = usePathname();
  const quality = useAdaptiveQuality();

  useEffect(() => {
    if (
      pathname?.startsWith("/super-admin") ||
      quality.rendering === "safe" ||
      quality.motion === "minimal"
    ) {
      return;
    }

    const idleWindow = window as IdleWindow;
    const schedule = idleWindow.requestIdleCallback
      ? (callback: () => void) =>
          idleWindow.requestIdleCallback?.(callback) ?? 0
      : (callback: () => void) => window.setTimeout(callback, 0);
    const cancel = idleWindow.cancelIdleCallback
      ? (id: number) => idleWindow.cancelIdleCallback?.(id)
      : (id: number) => window.clearTimeout(id);

    let cleanupObserver: (() => void) | undefined;
    const idleId = schedule(() => {
      const frameIds = new Set<number>();
      const loadHandlers = new Map<HTMLImageElement, () => void>();
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLImageElement) {
              applyEffects(node);
            } else if (node instanceof HTMLElement) {
              node
                .querySelectorAll<HTMLImageElement>("img.img-fx")
                .forEach(applyEffects);
            }
          });
        }
      });

      const clearPendingWork = () => {
        frameIds.forEach((frameId) =>
          window.cancelAnimationFrame(frameId),
        );
        frameIds.clear();
        loadHandlers.forEach((handler, image) =>
          image.removeEventListener("load", handler),
        );
        loadHandlers.clear();
      };

      function applyEffects(image: HTMLImageElement) {
        if (
          image.dataset.nimg !== undefined ||
          !image.classList.contains("img-fx")
        ) {
          return;
        }
        if (!image.getAttribute("loading")) {
          image.setAttribute("loading", "lazy");
        }
        if (image.classList.contains("img-loaded")) return;

        const markLoaded = () => {
          image.classList.add("img-loaded");
          const handler = loadHandlers.get(image);
          if (handler) image.removeEventListener("load", handler);
          loadHandlers.delete(image);
        };

        if (image.complete) {
          const frameId = window.requestAnimationFrame(() => {
            frameIds.delete(frameId);
            markLoaded();
          });
          frameIds.add(frameId);
          return;
        }

        loadHandlers.set(image, markLoaded);
        image.addEventListener("load", markLoaded);
      }

      const connect = () => {
        if (document.visibilityState === "hidden") return;
        document
          .querySelectorAll<HTMLImageElement>("img.img-fx")
          .forEach(applyEffects);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      };
      const handleVisibility = () => {
        observer.disconnect();
        clearPendingWork();
        connect();
      };

      connect();
      document.addEventListener("visibilitychange", handleVisibility);
      cleanupObserver = () => {
        document.removeEventListener("visibilitychange", handleVisibility);
        observer.disconnect();
        clearPendingWork();
      };
    });

    return () => {
      cleanupObserver?.();
      cancel(idleId);
    };
  }, [
    pathname,
    quality.motion,
    quality.rendering,
    quality.routeGeneration,
  ]);

  return null;
}
