export type ImageRemotePattern = {
  protocol: "http" | "https";
  hostname: string;
  port: string;
  pathname: string;
};

type ImagePolicyOptions = {
  production?: boolean;
  imageBaseUrl?: string;
  apiBaseUrl?: string;
  mediaCdnUrl?: string;
  allowDevLocal?: boolean;
};

const DEFAULT_PRODUCTION_API_BASE_URL = "https://api.infinitycolor.co/api";
const DEFAULT_DEVELOPMENT_API_BASE_URL = "http://localhost:1337/api";
const DEFAULT_PRODUCTION_IMAGE_BASE_URL = "https://api.infinitycolor.co";
const DEFAULT_DEVELOPMENT_IMAGE_BASE_URL = "http://localhost:1337";
const LOCAL_URL_BASE = "https://new.infinitycolor.local";
const IMAGE_UPLOAD_PATH_PREFIX = "/uploads/";
const NEXT_IMAGE_QUALITIES = [50, 60, 70, 75, 90, 95, 100] as const;

const DEV_LOCAL_IMAGE_ORIGINS = ["http://localhost:1337", "http://127.0.0.1:1337"];

const LOCAL_PUBLIC_PATH_PREFIXES = [
  "/images/",
  "/blog/",
  "/fonts/",
  "/Infinity.svg",
  "/favicon.ico",
];

function isProduction(options?: ImagePolicyOptions): boolean {
  return options?.production ?? process.env.NODE_ENV === "production";
}

function stripApiSuffix(value: string): string {
  return value.replace(/\/api\/?$/i, "");
}

function toUrl(raw?: string | null): URL | null {
  const value = raw?.trim();
  if (!value) return null;

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeImageInput(raw?: string | null): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";
  if (/^data:image\//i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed) || trimmed.includes("/uploads/") || /^uploads\//i.test(trimmed)) {
    return trimmed.replace(/\s+/g, "");
  }
  return trimmed;
}

function toOriginUrl(raw?: string | null): URL | null {
  const url = toUrl(raw);
  if (!url) return null;
  return new URL(url.origin);
}

function isIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d+$/.test(part)) return false;
      const value = Number(part);
      return Number.isInteger(value) && value >= 0 && value <= 255;
    })
  );
}

function isPrivateOrReservedIPv4(hostname: string): boolean {
  if (!isIPv4(hostname)) return false;

  const [a, b, c] = hostname.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function isDevLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isUnsafeHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);

  if (!normalized) return true;
  if (isDevLocalHostname(normalized)) return true;
  if (isPrivateOrReservedIPv4(normalized)) return true;
  if (normalized.includes(":")) return true;
  if (normalized === "metadata.google.internal") return true;
  if (normalized === "169.254.169.254") return true;
  if (
    normalized.endsWith(".local") ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home")
  ) {
    return true;
  }

  return !isIPv4(normalized) && !normalized.includes(".");
}

function isAllowedTrustedOrigin(url: URL, options?: ImagePolicyOptions): boolean {
  const production = isProduction(options);
  const allowDevLocal = options?.allowDevLocal ?? !production;

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (production && url.protocol !== "https:") return false;

  if (isUnsafeHostname(url.hostname)) {
    return allowDevLocal && !production;
  }

  return true;
}

function getImageBaseUrl(options?: ImagePolicyOptions): string {
  return (
    options?.imageBaseUrl ||
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL ||
    (isProduction(options) ? DEFAULT_PRODUCTION_IMAGE_BASE_URL : DEFAULT_DEVELOPMENT_IMAGE_BASE_URL)
  );
}

function getApiBaseUrl(options?: ImagePolicyOptions): string {
  return (
    options?.apiBaseUrl ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    (isProduction(options) ? DEFAULT_PRODUCTION_API_BASE_URL : DEFAULT_DEVELOPMENT_API_BASE_URL)
  );
}

function getMediaCdnUrl(options?: ImagePolicyOptions): string {
  return options?.mediaCdnUrl ?? process.env.NEXT_PUBLIC_MEDIA_CDN_URL ?? "";
}

/**
 * Optional CDN origin (e.g. https://cdn.infinitycolor.co) used to serve Strapi
 * `/uploads` media. Returns null when unset or not a safe trusted origin, so all
 * existing behavior is preserved when no CDN is configured.
 */
function getMediaCdnOrigin(options?: ImagePolicyOptions): URL | null {
  const origin = toOriginUrl(getMediaCdnUrl(options));
  if (!origin || !isAllowedTrustedOrigin(origin, options)) return null;
  return origin;
}

/**
 * Rewrite an already-validated `/uploads` URL to the CDN origin when configured.
 * Only `/uploads/*` paths are rewritten; local public assets and `data:` URLs
 * never reach here with an upload path, so they are left untouched.
 */
function applyMediaCdn(url: URL, options?: ImagePolicyOptions): string {
  const cdn = getMediaCdnOrigin(options);
  if (!cdn || !hasAllowedUploadPath(url)) return url.toString();
  return new URL(`${url.pathname}${url.search}${url.hash}`, cdn.origin).toString();
}

export function getTrustedImageOrigins(options?: ImagePolicyOptions): URL[] {
  const production = isProduction(options);
  const configuredOrigins = [
    toOriginUrl(stripApiSuffix(getImageBaseUrl(options))),
    toOriginUrl(stripApiSuffix(getApiBaseUrl(options))),
    // Trust the CDN origin so already-CDN upload URLs validate and the Next.js
    // image allowlist (remotePatterns) includes the CDN host.
    getMediaCdnOrigin(options),
    ...(!production ? DEV_LOCAL_IMAGE_ORIGINS.map(toOriginUrl) : []),
  ].filter((url): url is URL => Boolean(url));

  const seen = new Set<string>();
  return configuredOrigins.filter((url) => {
    if (!isAllowedTrustedOrigin(url, options)) return false;
    if (seen.has(url.origin)) return false;
    seen.add(url.origin);
    return true;
  });
}

export function getTrustedApiOrigins(options?: ImagePolicyOptions): URL[] {
  const apiOrigin = toOriginUrl(stripApiSuffix(getApiBaseUrl(options)));
  if (!apiOrigin || !isAllowedTrustedOrigin(apiOrigin, options)) return [];
  return [apiOrigin];
}

export function getTrustedImageSourceOrigins(options?: ImagePolicyOptions): string[] {
  return getTrustedImageOrigins(options).map((origin) => origin.origin);
}

export function getTrustedApiSourceOrigins(options?: ImagePolicyOptions): string[] {
  return getTrustedApiOrigins(options).map((origin) => origin.origin);
}

export function getNextImageRemotePatterns(options?: ImagePolicyOptions): ImageRemotePattern[] {
  return getTrustedImageOrigins(options).map((origin) => ({
    protocol: origin.protocol.replace(":", "") as "http" | "https",
    hostname: origin.hostname,
    port: origin.port,
    pathname: `${IMAGE_UPLOAD_PATH_PREFIX}**`,
  }));
}

function isLocalPublicAssetPath(pathname: string): boolean {
  return LOCAL_PUBLIC_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );
}

function normalizeLocalPublicAssetPath(path: string): string {
  try {
    const url = new URL(path, LOCAL_URL_BASE);
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

function sameOrigin(left: URL, right: URL): boolean {
  return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
}

function hasAllowedUploadPath(url: URL): boolean {
  return url.pathname.startsWith(IMAGE_UPLOAD_PATH_PREFIX);
}

export function isAllowedImageUrl(src?: string | null, options?: ImagePolicyOptions): boolean {
  const resolved = resolveSafeImageSrc(src, options);
  return Boolean(resolved);
}

export function resolveSafeImageSrc(src?: string | null, options?: ImagePolicyOptions): string {
  const raw = normalizeImageInput(src);
  if (!raw) return "";

  if (/^data:image\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return "";

  if (/^https?:\/\//i.test(raw)) {
    const url = toUrl(raw);
    if (!url || !hasAllowedUploadPath(url)) return "";

    const trustedOrigins = getTrustedImageOrigins(options);
    return trustedOrigins.some((origin) => sameOrigin(url, origin)) ? applyMediaCdn(url, options) : "";
  }

  const normalizedPath = raw.startsWith("/") ? raw : `/${raw}`;

  if (normalizedPath.startsWith(IMAGE_UPLOAD_PATH_PREFIX)) {
    const [origin] = getTrustedImageOrigins(options);
    if (!origin) return "";

    const url = new URL(normalizedPath, origin.origin);
    return hasAllowedUploadPath(url) ? applyMediaCdn(url, options) : "";
  }

  if (raw.startsWith("/") && isLocalPublicAssetPath(normalizedPath)) {
    return normalizeLocalPublicAssetPath(normalizedPath);
  }

  if (/^(images|blog|fonts)\//i.test(raw)) {
    return normalizeLocalPublicAssetPath(normalizedPath);
  }

  return "";
}

export function getNextImageQuality(quality?: number | null): number {
  const requested = typeof quality === "number" && Number.isFinite(quality) ? quality : 75;
  return NEXT_IMAGE_QUALITIES.reduce((closest, candidate) => {
    const currentDistance = Math.abs(candidate - requested);
    const closestDistance = Math.abs(closest - requested);
    return currentDistance < closestDistance ? candidate : closest;
  }, NEXT_IMAGE_QUALITIES[0]);
}

function getNextImageWidth(width?: number | null): number {
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.round(width) : 1920;
}

export function buildOptimizedImageUrl(
  src: string,
  width: number,
  quality: number,
  options?: ImagePolicyOptions,
): string {
  const safeSrc = resolveSafeImageSrc(src, options);
  if (!safeSrc || safeSrc.startsWith("data:")) return safeSrc;

  const url = new URL("/_next/image", LOCAL_URL_BASE);
  url.searchParams.set("url", safeSrc);
  url.searchParams.set("w", String(getNextImageWidth(width)));
  url.searchParams.set("q", String(getNextImageQuality(quality)));
  return `${url.pathname}${url.search}`;
}
