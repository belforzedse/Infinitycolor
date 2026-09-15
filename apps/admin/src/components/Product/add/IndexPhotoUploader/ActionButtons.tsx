import React from "react";
import EyeIcon from "../../Icons/EyeIcon";
import DeleteIcon from "../../Icons/DeleteIcon";
import EditIcon from "../../Icons/EditIcon";

interface ActionButtonsProps {
  onPreviewClick: () => void;
  onDeleteClick: () => void;
  onEditClick: () => void;
  disabled?: boolean;
}

const IndexPhotoUploaderActionButtons: React.FC<ActionButtonsProps> = ({
  onPreviewClick,
  onDeleteClick,
  onEditClick,
  disabled = false,
}) => {
  const primaryButtonClassNames =
    "bg-gray-100 rounded-xl text-gray-600 hover:bg-gray-200 transition-colors h-12 w-12 flex justify-center items-center disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex gap-2">
      <button
        type="button"
        disabled={disabled}
        data-testid="index-photo-preview"
        className={primaryButtonClassNames}
        onClick={onPreviewClick}
      >
        <EyeIcon className="h-6 w-6" />
      </button>
      <button
        type="button"
        disabled={disabled}
        data-testid="index-photo-delete"
        className={primaryButtonClassNames}
        onClick={onDeleteClick}
      >
        <DeleteIcon className="h-6 w-6" />
      </button>
      <button
        type="button"
        disabled={disabled}
        data-testid="index-photo-edit"
        className="flex h-12 w-12 items-center justify-center rounded-xl bg-infinity-primary text-white transition-colors hover:bg-infinity-primary disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onEditClick}
      >
        <EditIcon className="h-6 w-6" />
      </button>
    </div>
  );
};

export default IndexPhotoUploaderActionButtons;
