/**
 * Storefront service worker.
 *
 * Only public shell/static assets may be cached. Authenticated, account,
 * commerce, and API traffic always stays on the browser/network path.
 */

importScripts("/sw-version.js");

const BUILD_VERSION = self.__INFINITY_BUILD_VERSION__ || "v1-dev";

// Generate cache names with build version
function getCacheNames() {
  return {
    RUNTIME_CACHE: `runtime-cache-v${BUILD_VERSION}`,
  };
}

// URLs to cache on install
const URLS_TO_CACHE = ["/", "/offline.html", "/manifest.json"];

const SENSITIVE_PATH_PREFIXES = [
  "/api",
  "/auth",
  "/account",
  "/addresses",
  "/cart",
  "/checkout",
  "/favorites",
  "/orders",
  "/password",
  "/payment",
  "/privileges",
  "/super-admin",
  "/wallet",
];

function isSensitivePath(pathname) {
  return SENSITIVE_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Install event: cache essential files
 */
self.addEventListener("install", (event) => {
  console.log("[SW] Installing service worker...");
  const { RUNTIME_CACHE } = getCacheNames();

  event.waitUntil(
    Promise.all([
      // Load PWA clients from IndexedDB on install
      loadPWAClientsFromIDB(),
      // Cache essential files
      caches
        .open(RUNTIME_CACHE)
        .then((cache) => {
          return cache.addAll(URLS_TO_CACHE).catch((err) => {
            console.log("[SW] Some files failed to cache:", err);
            // Don't fail the install if some files fail
            return Promise.resolve();
          });
        }),
    ]).then(() => self.skipWaiting()),
  );
});

/**
 * Delete old caches that don't match current version
 */
async function deleteOldCaches() {
  try {
    const { RUNTIME_CACHE } = getCacheNames();
    const currentCaches = [RUNTIME_CACHE];
    
    const cacheNames = await caches.keys();
    const deletePromises = cacheNames
      .filter((cacheName) => !currentCaches.includes(cacheName))
      .map((cacheName) => {
        console.log("[SW] Deleting old cache:", cacheName);
        return caches.delete(cacheName);
      });
    
    await Promise.all(deletePromises);
  } catch (error) {
    console.error("[SW] Error deleting old caches:", error);
  }
}

/**
 * Activate event: clean up old caches
 */
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating service worker...");

  // Compute the full Promise chain first
  const activationPromise = deleteOldCaches().then(() => self.clients.claim());

  // Then pass the complete promise to waitUntil
  event.waitUntil(activationPromise);
});

/**
 * Fetch event: handle requests with caching strategies
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and non-http(s) schemes
  if (request.method !== "GET" || !url.protocol.startsWith("http")) {
    return;
  }

  // Never intercept cross-origin requests (e.g. api.infinitycolor.co).
  // Let the browser perform them so CORS is handled by the real API response.
  // Otherwise the SW can return 503 on failure without CORS headers → CORS error in console.
  try {
    if (url.origin !== self.origin) {
      return;
    }
  } catch (_) {
    return;
  }

  // Sensitive data and authorization-aware routes must never be intercepted,
  // cached, replayed, or replaced with synthetic service-worker responses.
  if (request.headers.has("Authorization") || isSensitivePath(url.pathname)) {
    return;
  }

  // Next.js owns cache busting and image optimization for these assets.
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/_next/chunks/") ||
    url.pathname.startsWith("/_next/image")
  ) {
    // Let these requests pass through without service worker interception
    return;
  }

  // Handle static assets with cache-first strategy
  if (isStaticAsset(url.pathname)) {
    event.respondWith(handleStaticAsset(request));
    return;
  }

  // Handle other requests with network-first strategy + offline fallback
  event.respondWith(handleGenericRequest(request));
});

/**
 * Handle static assets (cache-first with network fallback)
 * Images, CSS, JS, etc.
 * For images, we use network-first to ensure they load properly
 */
async function handleStaticAsset(request) {
  const { RUNTIME_CACHE } = getCacheNames();

  // For images, try network first to ensure they load properly
  // This prevents stale cache from blocking image loading
  if (request.destination === "image" || isImagePath(request.url)) {
    try {
      const response = await fetch(request);

      // Cache successful responses
      if (response.ok) {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(request, response.clone());
      }

      return response;
    } catch (error) {
      // If network fails, try cache
      const cached = await caches.match(request);
      if (cached) {
        return cached;
      }

      // Only return placeholder if truly offline and no cache
      console.log("[SW] Failed to fetch image:", request.url);
      // Return a transparent 1x1 PNG placeholder to avoid unhandled rejection
      // This prevents breaking offline UX while still allowing Next.js Image to handle gracefully
      return new Response(
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
          0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
          0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
          0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
          0x42, 0x60, 0x82
        ]),
        {
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "image/png" },
        }
      );
    }
  }

  // For other static assets, use cache-first
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);

    // Cache successful responses
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    console.log("[SW] Failed to fetch static asset:", request.url);
    // For other assets, return error
    return new Response("Asset not available offline", {
      status: 503,
      statusText: "Service Unavailable",
    });
  }
}

/**
 * Check if URL is an image path
 */
function isImagePath(url) {
  const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"];
  try {
    const urlObj = new URL(url);
    return imageExtensions.some((ext) => urlObj.pathname.toLowerCase().endsWith(ext));
  } catch {
    return false;
  }
}

// Store PWA mode status per client (in-memory cache)
const pwaModeClients = new Set();

// IndexedDB database name and store name for PWA mode persistence
const IDB_DB_NAME = "pwa-mode-db";
const IDB_STORE_NAME = "pwa-clients";

/**
 * Initialize IndexedDB for PWA mode persistence
 */
async function initPWAIndexedDB() {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(IDB_DB_NAME, 1);
      
      request.onerror = () => {
        console.warn("[SW] Failed to open IndexedDB for PWA mode, using in-memory only");
        resolve(null);
      };
      
      request.onsuccess = () => {
        resolve(request.result);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
          db.createObjectStore(IDB_STORE_NAME, { keyPath: "clientId" });
        }
      };
    } catch (error) {
      console.warn("[SW] IndexedDB not available, using in-memory only:", error);
      resolve(null);
    }
  });
}

/**
 * Load PWA mode clients from IndexedDB
 */
async function loadPWAClientsFromIDB() {
  try {
    const db = await initPWAIndexedDB();
    if (!db) {
      return; // Fall back to in-memory only
    }
    
    const transaction = db.transaction([IDB_STORE_NAME], "readonly");
    const store = transaction.objectStore(IDB_STORE_NAME);
    const request = store.getAll();
    
    request.onsuccess = () => {
      const clients = request.result || [];
      clients.forEach((item) => {
        if (item.clientId) {
          pwaModeClients.add(item.clientId);
        }
      });
      console.log("[SW] Loaded PWA clients from IndexedDB:", clients.length);
    };
    
    request.onerror = () => {
      console.warn("[SW] Failed to load PWA clients from IndexedDB");
    };
  } catch (error) {
    console.warn("[SW] Error loading PWA clients from IndexedDB:", error);
  }
}

/**
 * Store PWA client in IndexedDB
 */
async function storePWAClientInIDB(clientId, isPWA) {
  try {
    const db = await initPWAIndexedDB();
    if (!db) {
      return; // Fall back to in-memory only
    }
    
    const transaction = db.transaction([IDB_STORE_NAME], "readwrite");
    const store = transaction.objectStore(IDB_STORE_NAME);
    
    if (isPWA) {
      store.put({ clientId, isPWA, timestamp: Date.now() });
    } else {
      store.delete(clientId);
    }
  } catch (error) {
    console.warn("[SW] Error storing PWA client in IndexedDB:", error);
  }
}

/**
 * Check if a client is in PWA mode (standalone display mode)
 * Clients should send a message with type "PWA_MODE" and isPWA boolean
 */
async function isPWAMode(clientId) {
  // If we have stored info about this client, use it
  if (clientId && pwaModeClients.has(clientId)) {
    return true;
  }

  // Default: don't assume PWA mode (conservative approach)
  // offline.html should only show for confirmed PWA users
  return false;
}

// Load PWA clients from IndexedDB on service worker startup
loadPWAClientsFromIDB();

/**
 * Check if request is a navigation request (HTML page request)
 */
function isNavigationRequest(request) {
  // Check if request mode is navigate (browser navigation)
  if (request.mode === "navigate") {
    return true;
  }

  // Check Accept header for HTML content
  const acceptHeader = request.headers.get("Accept");
  if (acceptHeader && acceptHeader.includes("text/html")) {
    return true;
  }

  // Check if request destination is document
  if (request.destination === "document") {
    return true;
  }

  return false;
}

/**
 * Check if error indicates offline state (network error)
 */
function isNetworkError(error) {
  // Network errors typically have no response or are TypeError
  // Server errors (4xx, 5xx) are not network errors
  return (
    error instanceof TypeError ||
    error?.name === "NetworkError" ||
    error.message?.includes("Failed to fetch") ||
    error.message?.includes("NetworkError")
  );
}

/**
 * Handle generic requests (network-first)
 * Try network first, fall back to cache
 * Only show offline.html for PWA users when actually offline and for navigation requests
 */
async function handleGenericRequest(request) {
  const { RUNTIME_CACHE } = getCacheNames();

  try {
    const response = await fetch(request);

    return response;
  } catch (error) {
    // Check if this is a network error (offline) vs server error
    const isOffline = isNetworkError(error);

    // Try cache first
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    // Only show offline.html if:
    // 1. It's a navigation request (HTML page)
    // 2. User is actually offline (network error, not server error)
    // 3. User is in PWA mode (confirmed via client message)
    const isNav = isNavigationRequest(request);

    if (isNav && isOffline) {
      // Check if user is in PWA mode by checking stored client info
      try {
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        let isPWA = false;

        // Check if any of the clients are in PWA mode
        for (const client of clients) {
          const clientId = client.id || client.url || "default";
          if (pwaModeClients.has(clientId)) {
            isPWA = true;
            break;
          }
        }

        // Only return offline.html for PWA users
        if (isPWA) {
          const offlinePage = await caches.match("/offline.html");
          if (offlinePage) {
            console.log("[SW] Returning offline.html for PWA user");
            return offlinePage;
          }
        } else {
          console.log("[SW] Not showing offline.html - user is not in PWA mode");
        }
      } catch (err) {
        console.log("[SW] Error checking PWA mode:", err);
      }
    }

    // For non-navigation requests or when not offline, return appropriate error
    if (isNavigationRequest(request)) {
      // For navigation requests that failed but aren't offline, return error page
      return new Response("Page not available", {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // For API or other requests, return JSON error
    return new Response(JSON.stringify({ error: "Request failed", message: error.message }), {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Check if a path is a static asset
 */
function isStaticAsset(pathname) {
  const staticExtensions = [
    ".js",
    ".css",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
  ];
  return staticExtensions.some((ext) => pathname.endsWith(ext));
}

/**
 * Handle messages from clients
 */
self.addEventListener("message", (event) => {
  console.log("[SW] Message received:", event.data);

  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (event.data && event.data.type === "CLEAR_CACHE") {
    clearAllCaches();
  }

  // Handle PWA mode status from client
  if (event.data && event.data.type === "PWA_MODE") {
    // Get the client that sent the message
    const client = event.source;
    if (client) {
      const clientId = client.id || client.url || "default";
      const isPWA = event.data.isPWA;
      
      if (isPWA) {
        // Store client ID in memory and IndexedDB
        pwaModeClients.add(clientId);
        storePWAClientInIDB(clientId, true);
        console.log("[SW] Client is in PWA mode:", clientId);
      } else {
        // Remove client ID from memory and IndexedDB
        pwaModeClients.delete(clientId);
        storePWAClientInIDB(clientId, false);
        console.log("[SW] Client is not in PWA mode:", clientId);
      }
    }
  }
});

/**
 * Clear all caches
 */
async function clearAllCaches() {
  const cacheNames = await caches.keys();
  return Promise.all(cacheNames.map((name) => caches.delete(name)));
}

console.log("[SW] Service worker loaded");
