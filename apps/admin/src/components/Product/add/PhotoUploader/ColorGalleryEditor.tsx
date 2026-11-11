"use client";

import { useState } from "react";
import MediaLibraryModal from "@/components/MediaLibrary/MediaLibraryModal";
import { useProductEditor } from "@/hooks/product/ProductEditorContext";
import { useCan } from "@/hooks/useCan";
import { useOwnProductMedia } from "@/hooks/product/useOwnProductMedia";
import {
  toMediaDataItem,
  type MediaLibraryItem,
} from "@/services/super-admin/files/mediaLibrary";
import type { MediaDataItem } from "@/services/super-admin/product/get";
import PhotoUploaderImageGrid from "./ImageGrid";
import type { FileWithPreview } from "@/hooks/product/useUpload";
import { reorderArrayWithGuards } from "@/hooks/product/mediaReorder";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
interface ColorGalleryEditorProps {
  colorTitle: string;
  images: MediaDataItem[];
  onChange: (images: MediaDataItem[]) => void;
}

const IMAGE_TYPES = ["image"] as const;

export default function ColorGalleryEditor({
  colorTitle,
  images,
  onChange,
}: ColorGalleryEditorProps) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const { canEdit, state } = useProductEditor();
  const canManageMedia = useCan("product.media.manage");

  const disabled = !canEdit || state.busy || !canManageMedia;
  const ownMedia = useOwnProductMedia({ isEditMode: true, disabled });

  const handleSelect = (picked: MediaLibraryItem[]) => {
    if (disabled) return;

    const nextImages = new Map(images.map((image) => [image.id, image]));

    for (const item of picked) {
      if (item.mime.startsWith("image/")) {
        nextImages.set(item.id, toMediaDataItem(item));
      }
    }

    onChange([...nextImages.values()]);
    setLibraryOpen(false);
  };
  const previewItems: FileWithPreview[] = images.map((image) => ({
    id: String(image.id),
    file: new File([], image.attributes.name || "image", {
      type: image.attributes.mime,
    }),
    preview: resolveAssetUrl(image.attributes.url),
    uploadStatus: "uploaded",
    fileId: image.id,
  }));

  const handleRemove = (index: number) => {
    if (disabled) return;

    onChange(images.filter((_, imageIndex) => imageIndex !== index));
  };

  const handleReorder = (oldIndex: number, newIndex: number) => {
    if (disabled) return;

    onChange(reorderArrayWithGuards(images, oldIndex, newIndex));
  };
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-800">
          تصاویر {colorTitle}
        </h3>

        <button
          type="button"
          disabled={disabled}
          onClick={() => setLibraryOpen(true)}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:opacity-50"
        >
          انتخاب یا آپلود تصویر
        </button>
      </div>
      <fieldset disabled={disabled} className="mt-4 min-w-0">
        {images.length > 0 ? (
          <PhotoUploaderImageGrid
            items={previewItems}
            onRemoveFile={handleRemove}
            onReorder={disabled ? undefined : handleReorder}
          />
        ) : (
          <p className="text-sm text-slate-500">
            برای این رنگ تصویری انتخاب نشده است.
          </p>
        )}
      </fieldset>
      {canManageMedia && (
        <MediaLibraryModal
          isOpen={libraryOpen && !disabled}
          onClose={() => setLibraryOpen(false)}
          title={`تصاویر ${colorTitle}`}
          selection="multiple"
          allowedTypes={IMAGE_TYPES}
          ownMedia={ownMedia}
          maxSelection={30}
          lockedIds={new Set(images.map((image) => image.id))}
          lockedLabel="انتخاب‌شده"
          confirmLabel={() => "افزودن تصاویر"}
          onConfirm={handleSelect}
        />
      )}
    </section>
  );
}
