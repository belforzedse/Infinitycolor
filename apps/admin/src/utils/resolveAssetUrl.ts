import { resolveSafeImageSrc } from "@/utils/imageSecurity";

/**
 * Resolve a Strapi asset path (e.g. "/uploads/…") to an absolute URL.
 * Falls back to the API origin when IMAGE_BASE_URL is not configured.
 */
export const resolveAssetUrl = (path?: string | null): string => {
  return resolveSafeImageSrc(path);
};

export default resolveAssetUrl;
