import { apiClient } from "@/services";
import RecycleIcon from "../../Layout/Icons/RecycleIcon";
import UndoIcon from "../../Layout/Icons/UndoIcon";
import TrashIcon from "../../Layout/Icons/TrashIcon";
import SuperAdminTableCellActionButton from "./ActionButton";
import toast from "react-hot-toast";
import { useAtom } from "jotai";
import { refreshTable } from "..";
import { useState } from "react";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import { useCan } from "@/hooks/useCan";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

type Props = {
  isRemoved: boolean;
  id: string;
  apiUrl: string;
  itemName?: string;
  payloadFormatter?: (removedAt: string | null) => Record<string, unknown>;
  testIdPrefix?: string;
  /**
   * Override the `PUT ${apiUrl}/${id} { removedAt }` default for collections
   * whose removal is not a plain field write.
   *
   * Products need this: `removedAt` is outside the backend's operational field
   * allowlist, so the generic update path 400s for every non-Superadmin, and
   * removal goes through dedicated capability-gated endpoints instead. Every
   * other collection using this component (shipping, coupons, general discounts,
   * tags, comments, users) does carry `removedAt` in its allowlist and keeps the
   * default path.
   */
  onSoftDelete?: (id: string) => Promise<unknown>;
  onRestore?: (id: string) => Promise<unknown>;
  /**
   * Hides the soft-delete / restore controls when the role lacks the capability.
   * Defaults to visible, preserving today's behaviour for callers that pass
   * nothing. Column definitions are module-level consts in several tables, so
   * `useCan` cannot run in the cell — the caller resolves it and passes it down,
   * the same way this component already resolves hard delete for itself.
   */
  canSoftDelete?: boolean;
  canRestore?: boolean;
};

export default function RemoveActionButton(props: Props) {
  const { testIdPrefix } = props;
  const {
    isRemoved,
    id,
    apiUrl,
    itemName = "محصول",
    payloadFormatter,
    onSoftDelete,
    onRestore,
    canSoftDelete = true,
    canRestore = true,
  } = props;
  const [, setRefresh] = useAtom(refreshTable);
  const canHardDelete = useCan("system.purge.execute");
  const [isDeleting, setIsDeleting] = useState(false);
  const [showActionDialog, setShowActionDialog] = useState(false);
  const [showPermanentDeleteConfirm, setShowPermanentDeleteConfirm] =
    useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [showPermissionDenied, setShowPermissionDenied] = useState(false);

  const buildPayload = (removedAt: string | null) => {
    if (payloadFormatter) return payloadFormatter(removedAt);
    return {
      data: {
        removedAt,
      },
    };
  };

  const handleRestore = async () => {
    try {
      setIsDeleting(true);
      if (onRestore) await onRestore(id);
      else await apiClient.put(`${apiUrl}/${id}`, buildPayload(null));
      setRefresh(true);
      toast.success("با موفقیت بازیابی شد");
    } catch (error) {
      toast.error(getUserFacingErrorMessage(error, "بازیابی انجام نشد."));
      console.error("Failed to restore item:", error);
    } finally {
      setIsDeleting(false);
      setShowActionDialog(false);
      setShowRestoreConfirm(false);
    }
  };

  const handlePermanentDelete = async () => {
    try {
      setIsDeleting(true);
      await apiClient.delete(`${apiUrl}/${id}`);
      setRefresh(true);
      toast.success(`${itemName} به طور دائمی حذف شد`);
    } catch (error) {
      toast.error(
        getUserFacingErrorMessage(error, `حذف دائمی ${itemName} انجام نشد.`),
      );
      console.error("Failed to permanently delete item:", error);
    } finally {
      setIsDeleting(false);
      setShowPermanentDeleteConfirm(false);
      setShowActionDialog(false);
    }
  };

  const handleDelete = async () => {
    // Soft delete action - directly call API
    try {
      setIsDeleting(true);
      if (onSoftDelete) await onSoftDelete(id);
      else await apiClient.put(`${apiUrl}/${id}`, buildPayload(new Date().toISOString()));
      setRefresh(true);
      toast.success(`${itemName} با موفقیت حذف شد`);
    } catch (error) {
      toast.error(
        getUserFacingErrorMessage(error, `حذف ${itemName} انجام نشد.`),
      );
      console.error("Failed to delete item:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handlePermanentDeleteClick = () => {
    // Check if user is store manager - deny permanent delete
    if (!canHardDelete) {
      setShowPermissionDenied(true);
      return;
    }
    setShowPermanentDeleteConfirm(true);
  };

  // When item is removed, show both restore and permanent delete buttons
  if (isRemoved) {
    return (
      <>
        <div className="flex flex-row-reverse items-center gap-2">
          {canRestore && (
            <SuperAdminTableCellActionButton
              variant="primary"
              icon={<UndoIcon />}
              onClick={() => setShowRestoreConfirm(true)}
              disabled={isDeleting}
              testId={testIdPrefix ? `${testIdPrefix}-restore` : undefined}
              dataAttributes={{ id }}
            />
          )}
          <SuperAdminTableCellActionButton
            variant="secondary"
            icon={<TrashIcon />}
            onClick={handlePermanentDeleteClick}
            disabled={isDeleting}
            testId={testIdPrefix ? `${testIdPrefix}-hard-delete` : undefined}
            dataAttributes={{ id }}
          />
        </div>

        {/* Confirmation dialog for restore */}
        <ConfirmDialog
          isOpen={showRestoreConfirm}
          title="بازیابی"
          description={`این ${itemName} دوباره فعال و در فروشگاه نمایش داده می‌شود. ادامه می‌دهید؟`}
          confirmText="بله، بازیابی کن"
          cancelText="انصراف"
          onConfirm={handleRestore}
          onCancel={() => setShowRestoreConfirm(false)}
        />

        {/* Confirmation dialog for permanent delete */}
        <ConfirmDialog
          isOpen={showPermanentDeleteConfirm}
          title="حذف دائمی"
          description={`آیا از حذف دائمی این ${itemName} مطمئن هستید؟ این عملیات غیرقابل برگشت است.`}
          confirmText="بله، حذف کن"
          cancelText="انصراف"
          onConfirm={handlePermanentDelete}
          onCancel={() => setShowPermanentDeleteConfirm(false)}
        />

        {/* Permission denied dialog for store managers */}
        <ConfirmDialog
          isOpen={showPermissionDenied}
          title="عدم دسترسی"
          description="شما دسترسی مورد نظر برای این عمل رو ندارید"
          confirmText="باشه"
          cancelText={undefined}
          onConfirm={() => setShowPermissionDenied(false)}
          onCancel={() => setShowPermissionDenied(false)}
        />
      </>
    );
  }

  // When item is not removed, show only the soft delete button
  if (!canSoftDelete) return null;

  return (
    <SuperAdminTableCellActionButton
      variant="primary"
      icon={<RecycleIcon />}
      onClick={handleDelete}
      disabled={isDeleting}
      testId={testIdPrefix ? `${testIdPrefix}-soft-delete` : undefined}
      dataAttributes={{ id }}
    />
  );
}
