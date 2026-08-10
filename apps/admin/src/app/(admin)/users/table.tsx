import EditIcon from "@/components/SuperAdmin/Layout/Icons/EditIcon";
import KeyIcon from "@/components/SuperAdmin/Layout/Icons/KeyIcon";
import { refreshTable } from "@/components/SuperAdmin/Table";
import SuperAdminTableCellActionButton from "@/components/SuperAdmin/Table/Cells/ActionButton";
import RemoveActionButton from "@/components/SuperAdmin/Table/Cells/RemoveActionButton";
import SuperAdminTableCellSimplePrice from "@/components/SuperAdmin/Table/Cells/SimplePrice";
import SuperAdminTableCellSwitch from "@/components/SuperAdmin/Table/Cells/Switch";
import { apiClient } from "@/services";
import Modal from "@/components/Kits/Modal";
import { resolveUserRoleLabel } from "@/constants/roleLabels";
import { rialToToman } from "@/utils/price";
import type { ColumnDef, Row } from "@tanstack/react-table";
import { useAtom } from "jotai";
import { useState } from "react";
import { toast } from "react-hot-toast";
import {
  ResourceList,
  ResourceListItem,
  StatusBadge,
} from "@/components/admin";

export type UserInfo = {
  id: number;
  FirstName?: string | null;
  LastName?: string | null;
  NationalCode?: string | null;
  BirthDate?: string | null;
  Sex?: boolean | null;
  Bio?: string | null;
};

export type LocalUserRole = {
  id: number;
  Title?: string | null;
};

import type { PluginRoleInfo } from "@/services/user/getDetails";

export type UserWallet = {
  id: number;
  Balance?: string | number | null;
};

export type User = {
  id: string;
  attributes: any;
  username?: string | null;
  email?: string | null;
  phone?: string | null;
  confirmed?: boolean;
  blocked?: boolean;
  IsActive?: boolean;
  IsVerified?: boolean;
  removedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  user_info?: UserInfo | null;
  user_role?: LocalUserRole | null;
  role?: PluginRoleInfo | null;
  user_wallet?: UserWallet | null;
};

const deriveFullName = (user: User) => {
  const firstName = user.user_info?.FirstName ?? "";
  const lastName = user.user_info?.LastName ?? "";
  if (!firstName && !lastName) return "";
  return `${firstName} ${lastName}`.trim();
};

const StatusCell = ({ row }: { row: Row<User> }) => {
  const [status, setStatus] = useState(row.original.IsActive ? "active" : "inactive");
  const [isLoading, setIsLoading] = useState(false);

  const handleStatusChange = async (newStatus: "active" | "inactive") => {
    setIsLoading(true);

    try {
      await apiClient.put(`/users/${row.original.id}`, {
        IsActive: newStatus === "active",
      });

      toast.success("وضعیت کاربر با موفقیت تغییر کرد");
      setStatus(newStatus);
    } catch (error) {
      toast.error("خطا در تغییر وضعیت کاربر");
      console.error("Failed to update user status:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SuperAdminTableCellSwitch
      status={status as "active" | "inactive"}
      disabled={isLoading}
      onChange={() => handleStatusChange(status === "active" ? "inactive" : "active")}
    />
  );
};

const WalletCell = ({ row }: { row: Row<User> }) => {
  const walletData = row.original.user_wallet ?? null;
  // Balance is stored in Rial; SimplePrice labels values as Toman, so convert first.
  const walletBalance = rialToToman(walletData?.Balance ?? 0);

  return (
    <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-1">
      <SuperAdminTableCellSimplePrice price={walletBalance} />
    </div>
  );
};

const ActionsCell = ({ row }: { row: Row<User> }) => {
  const [, setRefresh] = useAtom(refreshTable);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [retryPassword, setRetryPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handlePasswordUpdate = async () => {
    if (newPassword !== retryPassword) {
      toast.error("رمز عبور و تکرار آن مطابقت ندارند");
      return;
    }

    setIsLoading(true);

    try {
      await apiClient.put(`/users/${row.original.id}`, {
        password: newPassword,
      });
      setShowPasswordModal(false);
      setNewPassword("");
      setRetryPassword("");
      setRefresh(true);
      toast.success("رمز عبور با موفقیت تغییر کرد");
    } catch (error) {
      toast.error("رمز عبور قوی نیست");
      console.error("Failed to update password:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const isRemoved = row.original.removedAt;

  return (
    <>
      <div className="flex flex-row-reverse items-center gap-3 p-1">
        <RemoveActionButton
          isRemoved={!!isRemoved}
          id={row.original.id.toString()}
          apiUrl={"/users"}
          payloadFormatter={(removedAt) => ({ removedAt })}
          itemName="کاربر"
          testIdPrefix="admin-user"
        />

        <SuperAdminTableCellActionButton
          variant="secondary"
          icon={<EditIcon />}
          path={`/users/edit/${row.original.id}`}
          testId="admin-user-edit"
          dataAttributes={{ id: row.original.id }}
        />

        <SuperAdminTableCellActionButton
          variant="secondary"
          icon={<KeyIcon />}
          onClick={() => setShowPasswordModal(true)}
        />
      </div>

      {/* Was a hand-rolled `fixed inset-0` overlay with a fixed w-96 (384px)
          panel — wider than an iPhone SE viewport — and no Escape handling,
          focus trap or backdrop close. Kits/Modal provides all three. */}
      <Modal
        isOpen={showPasswordModal}
        onClose={() => {
          if (!isLoading) setShowPasswordModal(false);
        }}
        title="تغییر رمز عبور"
        contentClassName="w-full max-w-sm"
      >
        <div className="flex flex-col gap-3" dir="rtl">
          <input
            type="password"
            placeholder="رمز عبور جدید"
            className="text-sm h-11 w-full rounded-lg border border-slate-200 px-3 md:h-10"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={isLoading}
            autoComplete="new-password"
          />
          <input
            type="password"
            placeholder="تکرار رمز عبور"
            className="text-sm h-11 w-full rounded-lg border border-slate-200 px-3 md:h-10"
            value={retryPassword}
            onChange={(e) => setRetryPassword(e.target.value)}
            disabled={isLoading}
            autoComplete="new-password"
          />
          <div className="mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              className="text-sm h-11 rounded-lg bg-slate-100 px-4 text-slate-700 disabled:opacity-50 md:h-10"
              onClick={() => setShowPasswordModal(false)}
              disabled={isLoading}
              type="button"
            >
              انصراف
            </button>
            <button
              className="text-sm h-11 rounded-lg bg-actions-primary px-4 text-white disabled:opacity-50 md:h-10"
              onClick={handlePasswordUpdate}
              disabled={isLoading}
              type="button"
            >
              {isLoading ? "در حال ذخیره..." : "ذخیره"}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
};

export const columns: ColumnDef<User>[] = [
  {
    accessorKey: "phone",
    header: "شماره تلفن",
    cell: ({ row }) => (
      <span
        data-testid="admin-user-row"
        data-id={row.original.id}
        data-user-phone={row.original.phone ?? ""}
        data-user-username={row.original.username ?? ""}
      >
        {row.original.phone ?? "-"}
      </span>
    ),
  },
  {
    accessorKey: "user_info",
    header: "نام",
    cell: ({ row }) => {
      const fullName = deriveFullName(row.original);
      return fullName ? <span className="text-sm text-neutral-800">{fullName}</span> : "-";
    },
  },
  {
    accessorKey: "role",
    header: "نقش",
    cell: ({ row }) => getRoleLabel(row.original),
  },
  {
    accessorKey: "IsActive",
    header: "وضعیت",
    cell: ({ row }) => <StatusCell row={row} />,
  },
  {
    accessorKey: "user_wallet",
    header: "موجودی کیف پول",
    cell: ({ row }) => <WalletCell row={row} />,
  },
  {
    accessorKey: "createdAt",
    header: "عملیات",
    meta: {
      headerClassName: "text-left",
      cellClassName: "text-left",
    },
    cell: ({ row }) => <ActionsCell row={row} />,
  },
];

type Props = {
  data: User[] | undefined;
};

/**
 * Compact-width users list.
 *
 * The person's name is the anchor; phone and role become secondary. The old
 * row put the phone number in the title slot and crammed name | role | a
 * non-functional account-status Switch into one un-wrapped line, hidden behind
 * an expand chevron.
 */
export const MobileTable = ({ data }: Props) => {
  return (
    <ResourceList className="mt-2">
      {data?.map((row) => {
        const rowWithStringId: User = { ...row, id: String(row.id) };
        const fullName = deriveFullName(row);
        const displayName = fullName || row.username || null;
        const wallet = row.user_wallet?.Balance ?? 0;

        return (
          <ResourceListItem
            key={row.id}
            href={`/users/edit/${row.id}`}
            title={
              <span className={displayName ? undefined : "text-neutral-400"}>
                {displayName ?? "بدون نام"}
              </span>
            }
            titleSuffix={row.phone ? <span dir="ltr">{row.phone}</span> : null}
            badge={
              <StatusBadge
                label={
                  row.blocked
                    ? "مسدود"
                    : row.IsActive
                      ? "فعال"
                      : "غیرفعال"
                }
                tone={
                  row.blocked ? "danger" : row.IsActive ? "success" : "neutral"
                }
              />
            }
            value={
              <SuperAdminTableCellSimplePrice price={rialToToman(wallet)} inverse />
            }
            valueCaption="موجودی کیف پول"
            meta={[
              getRoleLabel(row),
              row.confirmed ? "تایید شده" : "تایید نشده",
            ]}
            actions={<ActionsCell row={{ original: rowWithStringId } as Row<User>} />}
          />
        );
      })}
    </ResourceList>
  );
};

const getRoleLabel = resolveUserRoleLabel;
