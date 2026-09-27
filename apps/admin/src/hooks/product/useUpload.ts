import imageCompression from "browser-image-compression";
import { uploadFile } from "@/services/super-admin/files/upload";
import { useEffect, useMemo, useRef } from "react";
import logger from "@/utils/logger";
import toast from "react-hot-toast";
import { atom, useAtom, useAtomValue } from "jotai";
import {
  editProductDataAtom,
  productDataAtom,
} from "@/atoms/super-admin/products";
import type { FileType } from "@/components/Product/add/FileUploader/types";
import type { UploadStatus } from "@/components/Product/add/UploadStatusBadge";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import { generateStableId } from "@/utils/stableId";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import {
  toMediaDataItem,
  type MediaLibraryItem,
} from "@/services/super-admin/files/mediaLibrary";
import {
  extractMediaId,
  hasTypedMediaMime,
  reorderArrayWithGuards,
  reorderImageMediaPreservingSlots,
  shouldReorderUntypedMediaAsImages,
  type UploadMediaEntry,
} from "./mediaReorder";

interface UploadingState {
  image: boolean;
  video: boolean;
  other: boolean;
}

export const uploadingStateAtom = atom<UploadingState>({
  image: false,
  video: false,
  other: false,
});

export interface FileWithPreview {
  id: string;
  file: File;
  preview: string;
  uploadStatus: UploadStatus;
  uploadError?: string | null;
  /** The resolved URL this item was (or will be) reported as by the parent, used to
   * match it back up in `reconcileWithLocalPreviews` regardless of array position. */
  remoteUrl?: string;
  /** Strapi `plugin::upload.file` id from the upload response. Lets a video preview poll
   * for the backend's web-safe transcode of an HEVC/.mov clip instead of staying stuck
   * on a raw source the browser cannot decode. Undefined for items reconstructed from
   * `initialImages`/`initialVideos` URLs, which never had an upload response. */
  fileId?: number;
}

interface UseUploadProps {
  initialImages?: string[];
  initialVideos?: string[];
  initialFiles?: string[];
  isEditMode?: boolean;
}

const imagesAtom = atom<FileWithPreview[]>([]);
const videosAtom = atom<FileWithPreview[]>([]);
const filesAtom = atom<FileWithPreview[]>([]);

/** Read-only view of the gallery images the uploader is showing (add mode has no other source). */
export function useGalleryImages(): FileWithPreview[] {
  return useAtomValue(imagesAtom);
}

const cleanupObjectURLs = (items: FileWithPreview[]) => {
  items.forEach((item) => {
    if (item?.preview?.startsWith("blob:")) {
      URL.revokeObjectURL(item.preview);
    }
  });
};

const mapUrlsToFileWithPreview = (urls: string[], placeholderName: string) =>
  urls.map((url, index) => ({
    id: generateStableId(`${placeholderName}-`),
    file: new File([], `${placeholderName}-${index}`),
    preview: url,
    remoteUrl: url,
    uploadStatus: "uploaded" as const,
    uploadError: null,
  }));

// Reconciles the locally-tracked items against the URLs the parent now
// reports as uploaded. Items already known locally are matched by their
// resolved `remoteUrl` (not array position, which breaks across reorders and
// across the atoms' module-level state surviving a navigation to a different
// product) and keep their existing preview — notably a fresh item's own
// `blob:` preview — instead of being swapped to the resolved CDN/server URL,
// which can 404 for a few seconds right after upload while the CDN edge
// catches up. Items still "uploading"/"failed" are left alone since the
// parent doesn't know about them yet.
const reconcileWithLocalPreviews = (
  prevItems: FileWithPreview[],
  urls: string[],
  placeholderName: string,
): { next: FileWithPreview[]; stale: FileWithPreview[] } => {
  const uploaded = prevItems.filter((item) => item.uploadStatus === "uploaded");
  const pending = prevItems.filter((item) => item.uploadStatus !== "uploaded");
  const uploadedByUrl = new Map(
    uploaded.filter((item) => item.remoteUrl).map((item) => [item.remoteUrl as string, item]),
  );

  const reconciledUploaded = urls.map(
    (url) => uploadedByUrl.get(url) ?? mapUrlsToFileWithPreview([url], placeholderName)[0],
  );

  const keptIds = new Set(reconciledUploaded.map((item) => item.id));
  const stale = uploaded.filter((item) => !keptIds.has(item.id));

  return { next: [...reconciledUploaded, ...pending], stale };
};

const resolveMediaRemovalIndex = (
  media: any[],
  filteredIndex: number,
  mimePrefix: "image/" | "video/",
) => {
  const indexedMedia = media
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.attributes?.mime?.startsWith(mimePrefix));

  if (indexedMedia.length > 0) {
    return indexedMedia[filteredIndex]?.index ?? null;
  }

  return filteredIndex;
};

export function useUpload({
  initialImages,
  initialVideos,
  initialFiles,
  isEditMode = false,
}: UseUploadProps = {}) {
  const [images, setImages] = useAtom(imagesAtom);
  const [videos, setVideos] = useAtom(videosAtom);
  const [files, setFiles] = useAtom(filesAtom);

  const [uploadingState, setUploadingState] = useAtom(uploadingStateAtom);
  const [productData, setProductData] = useAtom(
    isEditMode ? editProductDataAtom : productDataAtom,
  );

  const previousImageKeyRef = useRef<string | null>(null);
  const previousVideoKeyRef = useRef<string | null>(null);
  const previousFileKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (initialImages === undefined) return;
    const normalizedImages = initialImages ?? [];
    const nextKey = JSON.stringify(normalizedImages);

    if (previousImageKeyRef.current === nextKey) return;
    previousImageKeyRef.current = nextKey;

    setImages((prevImages) => {
      const { next, stale } = reconcileWithLocalPreviews(prevImages, normalizedImages, "image");
      cleanupObjectURLs(stale);
      return next;
    });
  }, [initialImages, setImages]);

  useEffect(() => {
    if (initialVideos === undefined) return;
    const normalizedVideos = initialVideos ?? [];
    const nextKey = JSON.stringify(normalizedVideos);

    if (previousVideoKeyRef.current === nextKey) return;
    previousVideoKeyRef.current = nextKey;

    setVideos((prevVideos) => {
      const { next, stale } = reconcileWithLocalPreviews(prevVideos, normalizedVideos, "video");
      cleanupObjectURLs(stale);
      return next;
    });
  }, [initialVideos, setVideos]);

  useEffect(() => {
    if (initialFiles === undefined) return;
    const normalizedFiles = initialFiles ?? [];
    const nextKey = JSON.stringify(normalizedFiles);

    if (previousFileKeyRef.current === nextKey) return;
    previousFileKeyRef.current = nextKey;

    setFiles((prevFiles) => {
      const { next, stale } = reconcileWithLocalPreviews(prevFiles, normalizedFiles, "file");
      cleanupObjectURLs(stale);
      return next;
    });
  }, [initialFiles, setFiles]);

  const getFileType = (file: File): "image" | "video" | "other" => {
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("video/")) return "video";
    return "other";
  };

  const createPreview = (file: File): string => {
    const fileType = getFileType(file);
    if (fileType === "image" || fileType === "video") {
      return URL.createObjectURL(file);
    }
    return "/images/placeholders/file-placeholder.svg";
  };

  const optimizeImage = async (file: File): Promise<File> => {
    try {
      const optimized = await imageCompression(file, {
        maxSizeMB: 256,
        maxWidthOrHeight: 10920,
        useWebWorker: true,
        fileType: file.type,
      });
      return optimized;
    } catch (error) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "Image optimization failed, uploading original file",
          error,
        );
      }
      return file;
    }
  };

  const updateItemById = (
    type: FileType,
    id: string,
    patch: Partial<Pick<FileWithPreview, "uploadStatus" | "uploadError" | "remoteUrl" | "fileId">>,
  ) => {
    const updater = (items: FileWithPreview[]) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item));

    if (type === "image") {
      setImages(updater);
    } else if (type === "video") {
      setVideos(updater);
    } else {
      setFiles(updater);
    }
  };

  const addItem = (type: FileType, item: FileWithPreview) => {
    if (type === "image") {
      setImages((prevImages) => [...prevImages, item]);
    } else if (type === "video") {
      setVideos((prevVideos) => [...prevVideos, item]);
    } else {
      setFiles((prevFiles) => [...prevFiles, item]);
    }
  };

  const getItemsByType = (type: FileType) => {
    if (type === "image") return images;
    if (type === "video") return videos;
    return files;
  };

  const uploadedIndexBefore = (items: FileWithPreview[], index: number) =>
    items.slice(0, index).filter((item) => item.uploadStatus === "uploaded")
      .length;

  const uploadVisibleFile = async (
    item: FileWithPreview,
    targetType: FileType,
  ) => {
    const detectedFileType = getFileType(item.file);

    if (targetType === "image" && detectedFileType !== "image") {
      throw new Error("فقط بارگذاری تصاویر در این بخش مجاز است");
    }

    if (targetType === "video" && detectedFileType !== "video") {
      throw new Error("فایل ویدیویی معتبر نیست");
    }

    let uploadSource: File = item.file;

    if (detectedFileType === "image") {
      const optimizedBlob = await optimizeImage(item.file);
      uploadSource = new File([optimizedBlob], item.file.name, {
        type: optimizedBlob.type,
      });
    }

    const response = await uploadFile(uploadSource);
    if (!response?.[0]) {
      throw new Error("خطا در آپلود فایل");
    }

    if (process.env.NODE_ENV !== "production") {
      logger.info("response", { response });
    }

    if (detectedFileType === "image" || detectedFileType === "video") {
      setProductData((prev: any) => ({
        // TODO: Replace `any` usage with ProductData type
        ...prev,
        Media: [
          ...((prev as any).Media || []),
          isEditMode
            ? { id: response[0].id, attributes: response[0] }
            : response[0].id.toString(),
        ],
      }));
    } else {
      setProductData((prev: any) => ({
        // TODO: Replace `any` usage with ProductData type
        ...prev,
        Files: [
          ...((prev as any).Files || []),
          isEditMode
            ? { id: response[0].id, attributes: response[0] }
            : response[0].id.toString(),
        ],
      }));
    }

    updateItemById(targetType, item.id, {
      uploadStatus: "uploaded",
      uploadError: null,
      remoteUrl: resolveAssetUrl(response[0].url),
      fileId: response[0].id,
    });
  };

  // TODO: Revoke object URLs on unmount to avoid memory leaks

  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    fileType: FileType,
  ) => {
    const newFiles = Array.from(e.target.files || []);
    if (newFiles.length === 0) return;

    setUploadingState((prev) => ({ ...prev, [fileType]: true }));
    const uploadErrors: string[] = [];
    let totalSuccessful = 0;

    try {
      for (const file of newFiles) {
        const fileWithPreview: FileWithPreview = {
          id: generateStableId(`${fileType}-upload-`),
          file,
          preview: createPreview(file),
          uploadStatus: "uploading",
          uploadError: null,
        };

        addItem(fileType, fileWithPreview);

        try {
          await uploadVisibleFile(fileWithPreview, fileType);
          totalSuccessful += 1;
        } catch (error: any) {
          const friendlyMessage = getUserFacingErrorMessage(
            error,
            "خطا در آپلود فایل‌ها",
          );
          updateItemById(fileType, fileWithPreview.id, {
            uploadStatus: "failed",
            uploadError: friendlyMessage,
          });
          uploadErrors.push(`${file.name}: ${friendlyMessage}`);
        }
      }

      if (totalSuccessful > 0) {
        if (totalSuccessful === newFiles.length) {
          toast.success("همه فایل‌ها با موفقیت آپلود شدند");
        } else {
          toast(
            `${totalSuccessful} از ${newFiles.length} فایل با موفقیت آپلود شدند`,
            {
              icon: "⚠️",
            },
          );
        }
      }

      if (uploadErrors.length > 0) {
        uploadErrors.forEach((error) => {
          toast.error(error);
        });
      }
    } catch (error: any) {
      toast.error("خطا در آپلود فایل‌ها. لطفاً دوباره تلاش کنید.");
      console.error("Error uploading files:", error);
    } finally {
      setUploadingState((prev) => ({ ...prev, [fileType]: false }));
      e.target.value = "";
    }
  };

  const retryFile = async (index: number, type: FileType) => {
    const item = getItemsByType(type)[index];
    if (!item || item.uploadStatus !== "failed") return;

    updateItemById(type, item.id, {
      uploadStatus: "uploading",
      uploadError: null,
    });
    setUploadingState((prev) => ({ ...prev, [type]: true }));

    try {
      await uploadVisibleFile(item, type);
      toast.success("فایل با موفقیت آپلود شد");
    } catch (error: any) {
      const friendlyMessage = getUserFacingErrorMessage(
        error,
        "خطا در آپلود فایل",
      );
      updateItemById(type, item.id, {
        uploadStatus: "failed",
        uploadError: friendlyMessage,
      });
      toast.error(`${item.file.name}: ${friendlyMessage}`);
    } finally {
      setUploadingState((prev) => ({ ...prev, [type]: false }));
    }
  };

  const removeFile = (index: number, type: "image" | "video" | "other") => {
    switch (type) {
      case "image":
        if (images[index]?.preview?.startsWith("blob:")) {
          URL.revokeObjectURL(images[index].preview);
        }
        setImages((prevImages) => prevImages.filter((_, i) => i !== index));
        if (productData) {
          if (images[index]?.uploadStatus !== "uploaded") break;
          const media = ((productData as any).Media || []) as any[];
          const uploadedIndex = uploadedIndexBefore(images, index);
          const removalIndex = isEditMode
            ? resolveMediaRemovalIndex(media, uploadedIndex, "image/")
            : uploadedIndex;
          if (removalIndex !== null) {
            setProductData({
              ...(productData as any), // TODO: Strongly type productData
              Media: media.filter((_: any, i: number) => i !== removalIndex),
            });
          }
        }
        break;
      case "video":
        if (videos[index]?.preview?.startsWith("blob:")) {
          URL.revokeObjectURL(videos[index].preview);
        }
        setVideos((prevVideos) => prevVideos.filter((_, i) => i !== index));
        if (productData) {
          if (videos[index]?.uploadStatus !== "uploaded") break;
          const media = ((productData as any).Media || []) as any[];
          const uploadedIndex = uploadedIndexBefore(videos, index);
          const removalIndex = isEditMode
            ? resolveMediaRemovalIndex(media, uploadedIndex, "video/")
            : uploadedIndex;
          if (removalIndex !== null) {
            setProductData({
              ...(productData as any), // TODO: Strongly type productData
              Media: media.filter((_: any, i: number) => i !== removalIndex),
            });
          }
        }
        break;
      case "other":
        if (files[index]?.preview?.startsWith("blob:")) {
          URL.revokeObjectURL(files[index].preview);
        }
        setFiles((prevFiles) => prevFiles.filter((_, i) => i !== index));
        if (productData) {
          if (files[index]?.uploadStatus !== "uploaded") break;
          const uploadedIndex = uploadedIndexBefore(files, index);
          setProductData({
            ...(productData as any), // TODO: Strongly type productData
            Files: ((productData as any).Files || []).filter(
              (_: any, i: number) => i !== uploadedIndex,
            ),
          });
        }
        break;
    }
  };

  const mediaFileIds = useMemo(() => {
    const media = ((productData as any)?.Media || []) as unknown[];
    return new Set(
      media.map(extractMediaId).filter((id): id is number => id !== null),
    );
  }, [productData]);

  /**
   * Append files that are already uploaded (media library) to the gallery. They go to
   * `Media` in the atom's shape for this mode and to the local image list in the same
   * order, so add mode's position-based remove/reorder stays aligned; edit mode's
   * reconcile matches them back by `remoteUrl`.
   */
  const addExistingMedia = (picked: MediaLibraryItem[]) => {
    const seen = new Set(mediaFileIds);
    const fresh: MediaLibraryItem[] = [];
    for (const item of picked) {
      if (!item.mime.startsWith("image/") || seen.has(item.id)) continue;
      seen.add(item.id);
      fresh.push(item);
    }
    if (fresh.length > 0) {
      setProductData((prev: any) => ({
        // TODO: Replace `any` usage with ProductData type
        ...prev,
        Media: [
          ...((prev as any).Media || []),
          ...fresh.map((item) => (isEditMode ? toMediaDataItem(item) : String(item.id))),
        ],
      }));
      setImages((prevImages) => [
        ...prevImages,
        ...fresh.map((item) => {
          const url = resolveAssetUrl(item.url);
          return {
            id: generateStableId("image-library-"),
            file: new File([], item.name || `image-${item.id}`, { type: item.mime }),
            preview: url,
            remoteUrl: url,
            fileId: item.id,
            uploadStatus: "uploaded" as const,
            uploadError: null,
          };
        }),
      ]);
    }
    return { added: fresh.length, skipped: picked.length - fresh.length };
  };

  const reorderImages = (oldIndex: number, newIndex: number) => {
    setImages((prevImages) =>
      reorderArrayWithGuards(prevImages, oldIndex, newIndex),
    );

    setProductData((prev: any) => {
      // TODO: Replace cast with strongly typed product data
      if (!prev) return prev;

      const media = ((prev as any).Media || []) as UploadMediaEntry[];
      if (!Array.isArray(media) || media.length === 0) {
        return prev;
      }

      if (!images.every((image) => image.uploadStatus === "uploaded")) {
        return prev;
      }

      let nextMedia = media;

      // Edit mode media includes MIME metadata and can be reordered as an image subset.
      if (isEditMode || hasTypedMediaMime(media)) {
        nextMedia = reorderImageMediaPreservingSlots(media, oldIndex, newIndex);
      } else if (
        shouldReorderUntypedMediaAsImages({
          mediaLength: media.length,
          imageCount: images.filter(
            (image) => image.uploadStatus === "uploaded",
          ).length,
          videoCount: videos.filter(
            (video) => video.uploadStatus === "uploaded",
          ).length,
        })
      ) {
        // Add mode fallback when every media entry is currently an image.
        nextMedia = reorderArrayWithGuards(media, oldIndex, newIndex);
      }

      if (nextMedia === media) {
        return prev;
      }

      return {
        ...(prev as any),
        Media: nextMedia,
      };
    });
  };

  return {
    images,
    videos,
    files,
    uploadingState,
    handleFileUpload,
    removeFile,
    retryFile,
    reorderImages,
    mediaFileIds,
    addExistingMedia,
  };
}
