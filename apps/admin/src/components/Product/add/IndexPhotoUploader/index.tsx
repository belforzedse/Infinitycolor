"use client";

import React from "react";
import IndexPhotoUploaderImagePreview from "./ImagePreview";
import IndexPhotoUploaderActionButtons from "./ActionButtons";
import useIndexImageUpload from "../../../../hooks/useIndexImageUpload";

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
  } =
    useIndexImageUpload({ onImageUpload, onImageDelete, isEditMode, disabled });

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

      <span className="text-xs mt-3 text-neutral-400">
        {disabled
          ? "در حال دریافت اطلاعات محصول…"
          : "اینجا تصویر یا ویدیوی اصلی محصول را بارگذاری کنید."}
      </span>
    </div>
  );
};

export default IndexPhotoUploader;
