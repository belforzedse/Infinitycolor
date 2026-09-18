/**
 * Hostnames that 301 to the apex. The SW spec forbids fetching the worker
 * script through a redirect, so leftover registrations on these hosts fail
 * forever with "script resource is behind a redirect".
 */
export const SW_REDIRECT_HOSTNAMES = new Set(["new.infinitycolor.co", "www.infinitycolor.co"]);

export function isServiceWorkerRedirectHostname(hostname: string): boolean {
  return SW_REDIRECT_HOSTNAMES.has(hostname);
}

/**
 * Mutable indirection so tests can stub hostname without fighting jsdom's
 * locked Location or ESM export sealing.
 */
export const serviceWorkerHost = {
  getHostname(): string {
    return window.location.hostname;
  },
};
