type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Keeps optional enhancement downloads out of the initial document/LCP
 * waterfall. The task runs after `load`, then in an idle slot when supported.
 */
export function scheduleAfterCriticalLoad(task: () => void, idleTimeoutMs = 1_500): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }

  const idleWindow = window as IdleWindow;
  let cancelled = false;
  let idleHandle: number | null = null;
  let timerHandle: number | null = null;

  const schedule = () => {
    if (cancelled) return;
    if (typeof idleWindow.requestIdleCallback === "function") {
      idleHandle = idleWindow.requestIdleCallback(
        () => {
          if (!cancelled) task();
        },
        { timeout: idleTimeoutMs },
      );
      return;
    }

    timerHandle = window.setTimeout(() => {
      if (!cancelled) task();
    }, 0);
  };

  if (document.readyState === "complete") {
    schedule();
  } else {
    window.addEventListener("load", schedule, { once: true });
  }

  return () => {
    cancelled = true;
    window.removeEventListener("load", schedule);
    if (idleHandle !== null && typeof idleWindow.cancelIdleCallback === "function") {
      idleWindow.cancelIdleCallback(idleHandle);
    }
    if (timerHandle !== null) window.clearTimeout(timerHandle);
  };
}
