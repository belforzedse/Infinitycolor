"use client";

import { useEffect } from "react";
import {
  isServiceWorkerRedirectHostname,
  serviceWorkerHost,
} from "./service-worker-host";

/**
 * Spec: update() rejects InvalidStateError when newestWorker is null (no
 * installing, waiting, or active worker). Skip the call rather than letting
 * Safari surface an unhandled rejection from its own update path.
 */
function hasNewestWorker(registration: ServiceWorkerRegistration): boolean {
  return Boolean(registration.active || registration.waiting || registration.installing);
}

async function safeUpdate(registration: ServiceWorkerRegistration): Promise<void> {
  if (!hasNewestWorker(registration)) return;
  // Registration can be torn down mid-flight (navigation, another tab
  // unregistering). Best-effort only.
  await registration.update().catch(() => undefined);
}

async function unregisterAllWorkers(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
  await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
}

/**
 * Service Worker Registration Component
 * Registers the service worker for offline support and caching
 */
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    // Only register service worker in browser environment
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      console.log("[SW] Service workers not supported in this browser");
      return;
    }

    // Cutover hosts: clear stale workers and never register. SW script fetch
    // through a 301 is disallowed by the platform.
    if (isServiceWorkerRedirectHostname(serviceWorkerHost.getHostname())) {
      console.log("[SW] Redirect hostname — unregistering leftover workers");
      void unregisterAllWorkers();
      return;
    }

    let cleanup: (() => void) | undefined;
    let reloading = false;
    // A controller already present at mount means an earlier visit already
    // installed and activated a worker for this browsing session. sw.js calls
    // skipWaiting() unconditionally on install and clients.claim() on activate,
    // so a deploy can swap the controlling worker for an already-open tab with
    // no user action -- but nothing re-executes this tab's already-loaded
    // JavaScript. The checkout submit handler (and everything else already in
    // memory) keeps running the closure it was created with, now paired with a
    // service worker that has moved on to a different generation of caching
    // rules. Without a reload here that mismatch is invisible and permanent
    // until the customer closes and reopens the tab themselves -- which is how
    // "tap پرداخت, button disables for a second, nothing else happens" reached
    // production while an incognito tab (no service worker at all) worked fine.
    // Skip the very first controllerchange (no prior controller = first-ever
    // install taking over this tab, not a mid-session swap) so a first-time
    // visitor never gets an unexpected reload.
    const hadControllerAtMount = Boolean(navigator.serviceWorker.controller);

    registerServiceWorker().then((cleanupFn) => {
      cleanup = cleanupFn;
    });

    // Listen for service worker updates
    const handleControllerChange = () => {
      console.log("[SW] Service worker controller changed");
      if (!hadControllerAtMount || reloading) return;
      reloading = true;
      window.location.reload();
    };

    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    }

    return () => {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
      }
      if (cleanup) {
        cleanup();
      }
    };
  }, []);

  const registerServiceWorker = async (): Promise<(() => void) | undefined> => {
    try {
      console.log("[SW] Registering service worker...");

      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });

      // Browser automation and restrictive privacy modes can expose the
      // ServiceWorker API while blocking registration and resolving without a
      // registration object. Treat that as unsupported instead of dereferencing
      // `waiting` below.
      if (!registration) {
        return undefined;
      }

      console.log("[SW] Service worker registered successfully:", registration);

      if (registration.waiting && navigator.serviceWorker.controller) {
        notifyUpdateAvailable();
      }

      // Send PWA mode status to service worker (returns cleanup function)
      const pwaCleanup = sendPWAModeStatus(registration);

      // Prefer visibility-driven checks so background Safari tabs are not the
      // ones polling update() into newestWorker-is-null. A long-lived visible
      // tab still gets a slow periodic check.
      const requestUpdate = () => {
        void (async () => {
          const live = await navigator.serviceWorker.getRegistration().catch(() => undefined);
          if (!live) return;
          await safeUpdate(live);
        })();
      };

      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          requestUpdate();
        }
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);

      const updateInterval = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        requestUpdate();
      }, 60_000);

      // Handle service worker updates
      const handleUpdateFound = () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        // Capture newWorker reference before attaching listener
        const worker = newWorker;
        const handleStateChange = () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            console.log("[SW] New service worker available");
            // Notify user about update (optional)
            notifyUpdateAvailable();
          }
        };

        worker.addEventListener("statechange", handleStateChange);
      };

      registration.addEventListener("updatefound", handleUpdateFound);

      // Return cleanup function
      return () => {
        clearInterval(updateInterval);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        registration.removeEventListener("updatefound", handleUpdateFound);
        if (pwaCleanup) {
          pwaCleanup();
        }
      };
    } catch (error) {
      console.error("[SW] Failed to register service worker:", error);
      return undefined;
    }
  };

  const sendPWAModeStatus = (registration: ServiceWorkerRegistration): (() => void) | undefined => {
    try {
      // Check if user is in PWA mode (standalone display mode)
      const isPWA =
        window.matchMedia("(display-mode: standalone)").matches ||
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
        document.referrer.includes("android-app://");

      const sendMessage = (worker: ServiceWorker | null) => {
        if (worker) {
          worker.postMessage({
            type: "PWA_MODE",
            isPWA: isPWA,
          });
          console.log("[SW] PWA mode status sent to service worker:", isPWA);
        }
      };

      // Wait for service worker to be ready
      if (registration.active) {
        sendMessage(registration.active);
      } else if (registration.installing) {
        // Capture installing worker reference before attaching listener
        const installing = registration.installing;
        installing.addEventListener("statechange", (e) => {
          // Check event target's state instead of registration.installing which may be null
          const target = e.target as ServiceWorker;
          if (target?.state === "activated" && registration.active) {
            sendMessage(registration.active);
          }
        });
      } else if (registration.waiting) {
        sendMessage(registration.waiting);
      }

      // Also listen for when service worker becomes ready
      navigator.serviceWorker.ready.then((readyRegistration) => {
        if (readyRegistration.active) {
          sendMessage(readyRegistration.active);
        }
      });

      // Listen for display mode changes (if supported)
      if (window.matchMedia) {
        const mediaQuery = window.matchMedia("(display-mode: standalone)");
        const handleChange = () => {
          navigator.serviceWorker.ready.then((readyRegistration) => {
            if (readyRegistration.active) {
              const nextIsPWA =
                window.matchMedia("(display-mode: standalone)").matches ||
                (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
              readyRegistration.active.postMessage({
                type: "PWA_MODE",
                isPWA: nextIsPWA,
              });
            }
          });
        };
        // Some browsers support addEventListener on MediaQueryList
        if (mediaQuery.addEventListener) {
          mediaQuery.addEventListener("change", handleChange);
        } else {
          // Fallback for older browsers
          mediaQuery.addListener(handleChange);
        }

        // Return cleanup function to remove listener
        return () => {
          if (mediaQuery.removeEventListener) {
            mediaQuery.removeEventListener("change", handleChange);
          } else if (mediaQuery.removeListener) {
            mediaQuery.removeListener(handleChange);
          }
        };
      }

      return undefined;
    } catch (error) {
      console.error("[SW] Failed to send PWA mode status:", error);
      return undefined;
    }
  };

  const notifyUpdateAvailable = () => {
    window.dispatchEvent(new Event("infinity:app-update-available"));
  };

  return null; // This component doesn't render anything
}
