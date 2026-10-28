"use client";

import React, { useMemo, useState } from "react";
import { Images } from "lucide-react";
import IndexPhotoUploaderImagePreview from "./ImagePreview";
import IndexPhotoUploaderActionButtons from "./ActionButtons";
import useIndexImageUpload from "../../../../hooks/useIndexImageUpload";
import MediaLibraryModal from "@/components/MediaLibrary/MediaLibraryModal";
import { useCan } from "@/hooks/useCan";
import { useOwnProductMedia } from "@/hooks/product/useOwnProductMedia";
import { useProductEditor } from "@/hooks/product/ProductEditorContext";

const COVER_TYPES = ["image", "video"] as const;

interface IndexPhotoUploaderProps {
  onImageUpload?: (file: File) => void;
  onImageDelete?: () => void;
  isEditMode?: boolean;
  /** Blocks interaction while the owning product is still loading. */
  disabled?: boolean;
}

const IndexPhotoUploader: React.FC<IndexPhotoUploaderProps> = ({
  onImageUpload,
  onImageDelete,
  isEditMode = false,
  disabled = false,
}) => {
  const { canEdit } = useProductEditor();
  disabled = disabled || !canEdit;
  const {
    imagePreview,
    fileInputRef,
    handleImageUpload,
    handleDelete,
    handlePreviewClick,
    retryUpload,
    uploadStatus,
    uploadError,
    previewMimeType,
    isUploading,
    coverId,
    selectExistingCover,
  } =
    useIndexImageUpload({ onImageUpload, onImageDelete, isEditMode, disabled });
  const canPickFromLibrary = useCan("product.media.manage");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const ownMedia = useOwnProductMedia({ isEditMode, disabled });
  const lockedIds = useMemo(() => (coverId ? new Set([coverId]) : undefined), [coverId]);

  return (
    <div className="flex flex-col items-center gap-2 rounded-xl bg-white py-5">
      <div className="text-sm mb-0.5 text-neutral-600" style={{ direction: "rtl" }}>
        تصویر شاخص
      </div>

      <IndexPhotoUploaderImagePreview
        imagePreview={imagePreview}
        uploadStatus={uploadStatus}
        uploadError={uploadError}
        mimeType={previewMimeType}
        disabled={disabled}
        onRetry={retryUpload}
        onUploadButtonClick={() => {
          if (disabled) return;
          fileInputRef.current?.click();
        }}
      />

      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/*,video/*"
        disabled={disabled}
        onChange={handleImageUpload}
      />

      <IndexPhotoUploaderActionButtons
        disabled={disabled}
        onPreviewClick={handlePreviewClick}
        onDeleteClick={handleDelete}
        onEditClick={() => {
          if (disabled) return;
          fileInputRef.current?.click();
        }}
      />

      {canPickFromLibrary ? (
        <button
          type="button"
          data-testid="index-photo-library"
          disabled={disabled || isUploading}
          onClick={() => setLibraryOpen(true)}
          className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-infinity-primary transition-colors hover:border-infinity-primary-lighter hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Images className="h-4 w-4" aria-hidden="true" />
          انتخاب از کتابخانه
        </button>
      ) : null}

      <span className="text-xs mt-3 text-neutral-400">
        {disabled
          ? ""
          : canPickFromLibrary
            ? "تصویر یا ویدیوی اصلی محصول را بارگذاری یا از کتابخانه انتخاب کنید."
            : "اینجا تصویر یا ویدیوی اصلی محصول را بارگذاری کنید."}
      </span>

      {canPickFromLibrary ? (
        <MediaLibraryModal
          isOpen={libraryOpen && !disabled}
          onClose={() => setLibraryOpen(false)}
          title="انتخاب تصویر شاخص"
          selection="single"
          allowedTypes={COVER_TYPES}
          lockedIds={lockedIds}
          lockedLabel="کاور فعلی"
          ownMedia={ownMedia}
          confirmLabel={() => "تنظیم به‌عنوان تصویر شاخص"}
          onConfirm={([picked]) => {
            if (disabled) return;
            if (picked) selectExistingCover(picked);
            setLibraryOpen(false);
          }}
        />
      ) : null}
    </div>
  );
};

export default IndexPhotoUploader;
