"use client";

import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { editProductDataAtom } from "@/atoms/super-admin/products";
import {
  mediaDataItemToLibraryItem,
  type MediaLibraryItem,
} from "@/services/super-admin/files/mediaLibrary";
import { useGalleryImages } from "./useUpload";

/**
 * The product's own gallery images as library items, for promoting one to cover.
 *
 * Edit mode reads the saved `Media` relation (items the uploader rebuilds from URLs
 * carry no file id). Add mode has no saved relation, so it reads the uploader's list
 * and keeps only finished uploads.
 */
export function useOwnProductMedia({
  isEditMode,
  disabled = false,
}: {
  isEditMode: boolean;
  disabled?: boolean;
}): MediaLibraryItem[] {
  const editMedia = useAtomValue(editProductDataAtom).Media;
  const galleryImages = useGalleryImages();

  return useMemo(() => {
    if (disabled) return [];
    if (isEditMode) {
      return (editMedia ?? [])
        .filter((entry) => entry?.attributes?.mime?.startsWith("image/"))
        .map(mediaDataItemToLibraryItem);
    }
    return galleryImages
      .filter((image) => image.uploadStatus === "uploaded" && image.fileId && image.remoteUrl)
      .map((image) => ({
        id: image.fileId as number,
        name: image.file.name,
        alternativeText: null,
        url: image.remoteUrl as string,
        mime: image.file.type || "image/webp",
        ext: null,
        width: null,
        height: null,
        size: image.file.size ? image.file.size / 1024 : null,
        createdAt: null,
        formats: null,
        thumbnailUrl: image.remoteUrl as string,
        video: null,
        usage: { productCount: 0, removedProductCount: 0, usedAsCover: false, products: [] },
      }));
  }, [disabled, editMedia, galleryImages, isEditMode]);
}
