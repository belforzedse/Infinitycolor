import React, { useState } from "react";
import { useAtomValue } from "jotai";
import toast from "react-hot-toast";
import { Images } from "lucide-react";
import PhotoUploaderImageGrid from "./ImageGrid";
import UploadButton from "../UploadButton";
import { useUpload } from "@/hooks/product/useUpload";
import { useCan } from "@/hooks/useCan";
import { editProductDataAtom, productDataAtom } from "@/atoms/super-admin/products";
import MediaLibraryModal from "@/components/MediaLibrary/MediaLibraryModal";
import { faNum } from "@/utils/faNum";

interface PhotoUploaderProps {
  initialImages?: string[];
  isEditMode?: boolean;
}

const GALLERY_TYPES = ["image"] as const;
const MAX_LIBRARY_PICK = 30;

const PhotoUploader: React.FC<PhotoUploaderProps> = ({
  initialImages = [],
  isEditMode = false,
}) => {
  const {
    images,
    uploadingState,
    handleFileUpload,
    removeFile,
    retryFile,
    reorderImages,
    mediaFileIds,
    addExistingMedia,
  } = useUpload({
    initialImages,
    isEditMode,
  });
  const canPickFromLibrary = useCan("product.media.manage");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const editCoverId = useAtomValue(editProductDataAtom).CoverImage?.data?.id ?? null;
  const addCoverId = useAtomValue(productDataAtom).CoverImage?.data?.id ?? null;
  const currentCoverId = isEditMode ? editCoverId : addCoverId;

  return (
    <div className="w-full rounded-xl bg-white p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <span className="text-base text-neutral-600">تصاویر</span>
        <div className="flex flex-wrap items-center gap-2">
          {canPickFromLibrary ? (
            <button
              type="button"
              data-testid="gallery-library-open"
              disabled={uploadingState.image}
              onClick={() => setLibraryOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-infinity-primary transition-colors hover:border-infinity-primary-lighter hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Images className="h-4 w-4" aria-hidden="true" />
              انتخاب از کتابخانه
            </button>
          ) : null}
          <UploadButton onUpload={(e) => handleFileUpload(e, "image")} accept="image/*" />
        </div>
      </div>
      <PhotoUploaderImageGrid
        items={images}
        onRemoveFile={(index) => removeFile(index, "image")}
        onRetryFile={(index) => retryFile(index, "image")}
        onReorder={reorderImages}
      />

      {canPickFromLibrary ? (
        <MediaLibraryModal
          isOpen={libraryOpen}
          onClose={() => setLibraryOpen(false)}
          title="افزودن تصویر از کتابخانه"
          selection="multiple"
          allowedTypes={GALLERY_TYPES}
          maxSelection={MAX_LIBRARY_PICK}
          lockedIds={mediaFileIds}
          lockedLabel="در گالری"
          currentCoverId={currentCoverId}
          confirmLabel={(count) =>
            count > 0 ? `افزودن ${faNum(count)} تصویر به گالری` : "افزودن به گالری"
          }
          onConfirm={(picked) => {
            const { added, skipped } = addExistingMedia(picked);
            setLibraryOpen(false);
            if (added > 0) {
              toast.success(
                `${faNum(added)} تصویر به گالری اضافه شد${
                  skipped > 0 ? ` (${faNum(skipped)} مورد تکراری نادیده گرفته شد)` : ""
                }`,
              );
            }
          }}
        />
      ) : null}
    </div>
  );
};

export default PhotoUploader;
