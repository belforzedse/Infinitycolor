"use client";

import { useEffect } from "react";

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

    let cleanup: (() => void) | undefined;

    registerServiceWorker().then((cleanupFn) => {
      cleanup = cleanupFn;
    });

    // Listen for service worker updates
    const handleControllerChange = () => {
      console.log("[SW] Service worker controller changed");
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

      // Check for updates periodically
      const updateInterval = setInterval(() => {
        // The registration can be torn down mid-flight (navigation, another
        // tab unregistering it), which rejects this with things like
        // Chromium's "InvalidStateError: newestWorker is null". Best-effort
        // only; nothing here is actionable client-side.
        registration.update().catch(() => undefined);
      }, 60000); // Check every minute

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
        (window.navigator as any).standalone === true ||
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
      navigator.serviceWorker.ready.then((registration) => {
        if (registration.active) {
          sendMessage(registration.active);
        }
      });

      // Listen for display mode changes (if supported)
      if (window.matchMedia) {
        const mediaQuery = window.matchMedia("(display-mode: standalone)");
        const handleChange = () => {
          navigator.serviceWorker.ready.then((registration) => {
            if (registration.active) {
              const isPWA =
                window.matchMedia("(display-mode: standalone)").matches ||
                (window.navigator as any).standalone === true;
              registration.active.postMessage({
                type: "PWA_MODE",
                isPWA: isPWA,
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
          if (mediaQuery) {
            if (mediaQuery.removeEventListener) {
              mediaQuery.removeEventListener("change", handleChange);
            } else if (mediaQuery.removeListener) {
              mediaQuery.removeListener(handleChange);
            }
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
