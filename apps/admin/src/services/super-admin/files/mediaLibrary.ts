import { apiClient } from "@/services";
import type { MediaDataItem } from "@/services/super-admin/product/get";
import type { UploadedImage } from "./upload";

export const ADMIN_MEDIA_LIBRARY_ENDPOINT = "/admin/media-library/query";

export type MediaLibraryType = "image" | "video";
export type MediaLibraryUsageFilter = "all" | "attached" | "unattached";

export type MediaLibraryFormat = {
  url: string;
  width: number | null;
  height: number | null;
  mime: string | null;
};

export type MediaLibraryUsageProduct = {
  id: number;
  title: string;
  removed: boolean;
  asCover: boolean;
};

export type MediaLibraryItem = {
  id: number;
  name: string;
  alternativeText: string | null;
  url: string;
  mime: string;
  ext: string | null;
  width: number | null;
  height: number | null;
  /** Kilobytes, as Strapi stores it. */
  size: number | null;
  createdAt: string | null;
  formats: Partial<Record<"thumbnail" | "small" | "medium" | "large", MediaLibraryFormat>> | null;
  thumbnailUrl: string | null;
  video: { status: string | null; posterUrl: string | null } | null;
  usage: {
    productCount: number;
    removedProductCount: number;
    usedAsCover: boolean;
    products: MediaLibraryUsageProduct[];
  };
};

export type MediaLibraryResponse = {
  data: MediaLibraryItem[];
  meta: {
    pagination: { page: number; pageSize: number; pageCount: number; total: number };
  };
};

export type MediaLibraryInput = {
  page: number;
  pageSize: number;
  type: MediaLibraryType;
  usage: MediaLibraryUsageFilter;
  search?: string;
  signal?: AbortSignal;
};

/**
 * Catalog media for the product picker: files used only by products plus unattached
 * uploads. The stock `/upload/files` would list every upload in the system (applicant
 * photos included) and ignores the paging the admin sends.
 */
export async function listMediaLibrary(input: MediaLibraryInput): Promise<MediaLibraryResponse> {
  const response = await apiClient.post<MediaLibraryItem[]>(
    ADMIN_MEDIA_LIBRARY_ENDPOINT,
    {
      page: input.page,
      pageSize: input.pageSize,
      type: input.type,
      usage: input.usage,
      search: input.search?.trim() || undefined,
    },
    { signal: input.signal, retries: 0, timeout: 20_000 },
  );
  const typed = response as unknown as MediaLibraryResponse;
  const data = Array.isArray(typed?.data) ? typed.data : [];
  return {
    data,
    meta: typed?.meta ?? {
      pagination: { page: input.page, pageSize: input.pageSize, pageCount: 0, total: data.length },
    },
  };
}

export const VIDEO_PROCESSING_STATUSES = new Set(["queued", "probing", "processing"]);

export function isFailedVideo(item: Pick<MediaLibraryItem, "video">): boolean {
  return item.video?.status === "failed";
}

/** Shape the product atoms hold for CoverImage/Media entries (edit-mode relation form). */
export function toMediaDataItem(item: MediaLibraryItem): MediaDataItem {
  return {
    id: item.id,
    attributes: {
      name: item.name,
      alternativeText: item.alternativeText,
      caption: null,
      width: item.width,
      height: item.height,
      formats: item.formats,
      hash: "",
      ext: item.ext ?? "",
      mime: item.mime,
      size: item.size ?? 0,
      url: item.url,
      previewUrl: null,
      provider: "",
      provider_metadata: null,
      createdAt: item.createdAt ?? "",
      updatedAt: item.createdAt ?? "",
    },
  };
}

export function mediaDataItemToLibraryItem(entry: MediaDataItem): MediaLibraryItem {
  const attributes = entry.attributes;
  const formats = (attributes.formats ?? null) as MediaLibraryItem["formats"];
  return {
    id: entry.id,
    name: attributes.name ?? "",
    alternativeText: attributes.alternativeText ?? null,
    url: attributes.url,
    mime: attributes.mime ?? "",
    ext: attributes.ext ?? null,
    width: attributes.width ?? null,
    height: attributes.height ?? null,
    size: attributes.size ?? null,
    createdAt: attributes.createdAt ?? null,
    formats,
    thumbnailUrl: formats?.small?.url ?? formats?.thumbnail?.url ?? attributes.url ?? null,
    video: attributes.mime?.startsWith("video/")
      ? { status: attributes.provider_metadata?.video?.status ?? null, posterUrl: null }
      : null,
    usage: { productCount: 0, removedProductCount: 0, usedAsCover: false, products: [] },
  };
}

/** A file just uploaded inside the picker: unattached until the product is saved. */
export function uploadedImageToLibraryItem(uploaded: UploadedImage): MediaLibraryItem {
  return mediaDataItemToLibraryItem({
    id: uploaded.id,
    attributes: {
      ...uploaded,
      alternativeText: uploaded.alternativeText ?? null,
      caption: uploaded.caption ?? null,
      previewUrl: uploaded.previewUrl ?? null,
      provider_metadata: uploaded.provider_metadata ?? null,
    },
  });
}
