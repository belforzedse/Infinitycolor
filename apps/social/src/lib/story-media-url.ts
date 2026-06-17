import { IMAGE_BASE_URL, MEDIA_CDN_URL } from "@repo/api/config";

function getOrigin(raw?: string): URL | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed.replace(/\/api\/?$/i, ""));
  } catch {
    return null;
  }
}

function isSameOrigin(left: URL, right: URL): boolean {
  return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
}

function resolveUploadsUrl(raw: string): string | null {
  const normalized = raw.trim().replace(/\s+/g, "");
  const imageOrigin = getOrigin(IMAGE_BASE_URL);
  const cdnOrigin = getOrigin(MEDIA_CDN_URL);

  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    try {
      const url = new URL(normalized);
      const isTrustedUpload =
        url.pathname.startsWith("/uploads/") &&
        ((imageOrigin && isSameOrigin(url, imageOrigin)) ||
          (cdnOrigin && isSameOrigin(url, cdnOrigin)));

      if (!isTrustedUpload) return url.toString();
      if (!cdnOrigin) return url.toString();
      return new URL(`${url.pathname}${url.search}${url.hash}`, cdnOrigin.origin).toString();
    } catch {
      return null;
    }
  }

  const base = imageOrigin;
  const path = normalized.replace(/^\/+/, "");
  if (!base) return `/${path}`;

  const url = new URL(`/${path}`, base.origin);
  if (!cdnOrigin || !url.pathname.startsWith("/uploads/")) return url.toString();
  return new URL(`${url.pathname}${url.search}${url.hash}`, cdnOrigin.origin).toString();
}

export function buildStoryMediaUrl(url: string): string {
  return resolveUploadsUrl(url) ?? "";
}
