import { useEffect, useRef, useState } from "react";
import { uploadFile } from "@/services/super-admin/files/upload";
import { useAtom } from "jotai";
import { editProductDataAtom, productDataAtom } from "@/atoms/super-admin/products";
import toast from "react-hot-toast";
import { Download } from "@/services/super-admin/files/download";
import { resolveAssetUrl } from "@/utils/resolveAssetUrl";
import type { UploadStatus } from "@/components/Product/add/UploadStatusBadge";

interface UseIndexImageUploadProps {
  onImageUpload?: (file: File) => void;
  onImageDelete?: () => void;
  isEditMode?: boolean;
  disabled?: boolean;
}

interface UseIndexImageUploadReturn {
  imagePreview: string | null;
  fileInputRef: React.RefObject<HTMLInputElement>;
  handleImageUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleDelete: () => void;
  handlePreviewClick: () => void;
  retryUpload: () => void;
  isUploading: boolean;
  uploadStatus: UploadStatus;
  uploadError: string | null;
  previewMimeType?: string;
}

/** Local stand-in for the picked file, shown only while its upload is pending or failed. */
interface PendingPreview {
  url: string;
  mime: string;
}

const useIndexImageUpload = ({
  onImageUpload,
  onImageDelete,
  isEditMode = false,
  disabled = false,
}: UseIndexImageUploadProps): UseIndexImageUploadReturn => {
  const [pendingPreview, setPendingPreviewState] = useState<PendingPreview | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null) as React.RefObject<HTMLInputElement>;
  const lastFileRef = useRef<File | null>(null);
  const pendingPreviewUrlRef = useRef<string | null>(null);
  const [productData, setProductData] = useAtom(isEditMode ? editProductDataAtom : productDataAtom);

  // The saved cover is derived from the atom on every render rather than latched into
  // local state. A latched preview survived product switches: the old one-way effect
  // only ever *set* the preview, so opening a product without a cover kept showing the
  // previously opened product's image. `disabled` means the owning page is still
  // loading, so the shared atom holds whichever product was open before — render none
  // of it until this product's own data has landed.
  const coverAttributes = disabled ? null : (productData.CoverImage?.data?.attributes ?? null);
  const savedPreview = coverAttributes?.url ? resolveAssetUrl(coverAttributes.url) : null;

  const imagePreview = pendingPreview?.url ?? savedPreview ?? null;
  const previewMimeType = pendingPreview?.mime ?? coverAttributes?.mime ?? undefined;
  const uploadStatus: UploadStatus = isUploading
    ? "uploading"
    : uploadError
      ? "failed"
      : imagePreview
        ? "uploaded"
        : "idle";

  const setPendingPreview = (next: PendingPreview | null) => {
    const previous = pendingPreviewUrlRef.current;
    if (previous && previous !== next?.url && previous.startsWith("blob:")) {
      URL.revokeObjectURL(previous);
    }
    pendingPreviewUrlRef.current = next?.url ?? null;
    setPendingPreviewState(next);
  };

  useEffect(
    () => () => {
      const previous = pendingPreviewUrlRef.current;
      if (previous?.startsWith("blob:")) {
        URL.revokeObjectURL(previous);
      }
    },
    [],
  );

  const showPendingPreview = (file: File) => {
    if (file.type.startsWith("video/")) {
      setPendingPreview({ url: URL.createObjectURL(file), mime: file.type });
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      // A newer selection (or a finished upload) has already taken over.
      if (lastFileRef.current !== file) return;
      setPendingPreview({ url: reader.result as string, mime: file.type });
    };
    reader.readAsDataURL(file);
  };

  const uploadSelectedFile = async (file: File) => {
    setIsUploading(true);
    setUploadError(null);

    try {
      const response = await uploadFile(file);
      if (!response?.[0]) {
        throw new Error("خطا در آپلود تصویر/ویدیوی شاخص");
      }

      // Functional update: the atom may have been replaced (product switch, initial
      // fetch landing) while the upload was in flight.
      setProductData((prev: any) => ({
        ...(prev as any),
        // TODO: Replace cast with proper product type
        CoverImage: {
          data: {
            id: response[0].id,
            attributes: response[0],
          },
        },
      }));
      lastFileRef.current = null;
      setPendingPreview(null);
      onImageUpload?.(file);
      setUploadError(null);
      const isVideo = file.type.startsWith("video/");
      toast.success(isVideo ? "ویدیوی شاخص با موفقیت آپلود شد" : "تصویر شاخص با موفقیت آپلود شد");
    } catch (error: any) {
      // TODO: Define a proper error type instead of using `any`
      const message = error?.message || "خطا در آپلود تصویر/ویدیوی شاخص";
      setUploadError(message);
      toast.error(message);
      console.error("Error uploading index image:", error);
    } finally {
      setIsUploading(false);
    }
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    const file = event.target.files?.[0];
    if (!file) return;

    lastFileRef.current = file;
    showPendingPreview(file);
    await uploadSelectedFile(file);
    event.target.value = "";
  };

  const retryUpload = () => {
    if (disabled || !lastFileRef.current || uploadStatus !== "failed") return;
    void uploadSelectedFile(lastFileRef.current);
  };

  const handleDelete = () => {
    if (disabled) return;
    setPendingPreview(null);
    setUploadError(null);
    lastFileRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setProductData((prev: any) => ({
      ...(prev as any),
      CoverImage: {
        data: null,
      },
    }));
    onImageDelete?.();
  };

  const handlePreviewClick = async () => {
    if (imagePreview) {
      window.open(imagePreview, "_blank", "noopener,noreferrer");
      return;
    }

    try {
      const fileId = productData.CoverImage?.data?.id;
      if (!fileId) {
        toast.error("تصویری انتخاب نشده است");
        return;
      }
      const response = await Download(fileId.toString());
      if (response?.url) {
        window.open(resolveAssetUrl(response.url), "_blank", "noopener,noreferrer");
      } else {
        toast.error("آدرس تصویر در دسترس نیست");
      }
    } catch (error) {
      console.error("Error previewing image:", error);
      toast.error("خطا در نمایش تصویر");
    }
  };

  return {
    imagePreview,
    fileInputRef,
    handleImageUpload,
    handleDelete,
    handlePreviewClick,
    retryUpload,
    isUploading,
    uploadStatus,
    uploadError,
    previewMimeType,
  };
};

export default useIndexImageUpload;
