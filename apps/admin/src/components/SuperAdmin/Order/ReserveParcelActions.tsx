"use client";

import { useState } from "react";
import { useSetAtom } from "jotai";
import { Printer, Copy, Eye, Truck, ScanLine } from "lucide-react";
import { OverflowMenu } from "@/components/admin";
import { refreshTable } from "@/components/SuperAdmin/Table/refreshTableAtom";
import { useCan } from "@/hooks/useCan";
import toast from "react-hot-toast";
import AnipoBarcodeDialog from "./AnipoBarcodeDialog";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import {
  checkAdminParcel,
  submitAdminParcel,
  type AnipoParcelSummary,
} from "@/services/super-admin/orders/reserveGroups";

export default function ReserveParcelActions({
  groupKey,
  parcel,
  onChanged,
}: {
  groupKey: string;
  parcel?: AnipoParcelSummary;
  onChanged?: () => void | Promise<void>;
}) {
  const canPrint = useCan("order.print");
  const canManageShipping = useCan("order.shipping.manage");
  const setRefresh = useSetAtom(refreshTable);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const path = encodeURIComponent(groupKey);

  const run = async (check: boolean, weight?: number, boxSizeId?: number) => {
    if (busy || !canManageShipping) return;
    setBusy(true);
    try {
      const result = check
        ? await checkAdminParcel(groupKey)
        : await submitAdminParcel(groupKey, weight, boxSizeId);
      if (result.state === "NeedsAttention")
        toast.error("بارکد بسته نیاز به بررسی دارد");
      else
        toast.success(
          result.issued
            ? "بارکد بسته صادر شد"
            : "بسته در انتظار تأیید آنیپو است",
        );
      setDialogOpen(false);
      setRefresh(true);
      await onChanged?.();
    } catch (error) {
      toast.error(
        getUserFacingErrorMessage(
          error,
          "درخواست آنیپو انجام نشد؛ دوباره تلاش کنید",
        ),
      );
      setRefresh(true);
      await onChanged?.();
    } finally {
      setBusy(false);
    }
  };
  const anipoLabel = busy
    ? "در حال بررسی…"
    : parcel?.isHeld
      ? "در مهلت رزرو"
      : parcel?.recipientSyncState === "NeedsAttention"
        ? "نیاز به بررسی نشانی آنیپو"
        : parcel?.state === "Issued"
          ? "بارکد صادر شده"
          : parcel?.canCheck
            ? "بررسی آنیپو"
            : parcel?.canSubmit
              ? "ثبت در آنیپو"
              : parcel?.state === "NeedsAttention"
                ? "نیاز به بررسی آنیپو"
                : "آنیپو";

  return (
    <>
      <div
        className="flex shrink-0 flex-wrap items-center justify-end gap-1.5"
        data-testid="reserve-parcel-actions"
      >
        {canPrint && (
          <a
            href={`/orders/print/reserve/${path}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="چاپ فاکتور کل بسته"
            title="چاپ فاکتور کل بسته"
            className="flex h-9 w-9 items-center justify-center rounded-md bg-blue-50 text-blue-600 hover:bg-blue-100 md:h-8 md:w-8"
          >
            <Printer className="h-4 w-4" aria-hidden="true" />
          </a>
        )}
        {canManageShipping &&
          parcel?.shippingMethodCode?.toLowerCase() === "post" && (
            <button
              type="button"
              disabled={busy || !(parcel.canSubmit || parcel.canCheck)}
              onClick={() =>
                parcel.canCheck ? void run(true) : setDialogOpen(true)
              }
              className={`min-h-9 rounded-md px-2.5 text-xs md:min-h-8 ${
                parcel.recipientSyncState === "NeedsAttention"
                  ? "bg-red-50 text-red-700"
                  : parcel.state === "Issued"
                    ? "bg-green-50 text-green-600"
                    : parcel.state === "NeedsAttention"
                      ? "bg-red-50 text-red-700"
                      : "bg-orange-50 text-orange-600"
              } disabled:cursor-default`}
              title={parcel.blockedReason || undefined}
            >
              {anipoLabel}
            </button>
          )}
        <OverflowMenu
          className="[&_button[aria-haspopup]]:h-9 [&_button[aria-haspopup]]:w-9 md:[&_button[aria-haspopup]]:h-8 md:[&_button[aria-haspopup]]:w-8"
          label="عملیات بسته"
          actions={[
            {
              id: "details",
              label: "جزئیات بسته",
              icon: <Eye className="h-4 w-4" />,
              href: `/orders/reserve/${path}`,
            },
            {
              id: "copy",
              label: "کپی شناسه بسته",
              icon: <Copy className="h-4 w-4" />,
              onSelect: () => {
                void navigator.clipboard
                  .writeText(groupKey)
                  .catch(() => toast.error("کپی انجام نشد"));
              },
            },
            ...(canPrint && parcel?.canPrintLabel
              ? [
                  {
                    id: "label",
                    label: "چاپ برچسب پستی",
                    icon: <ScanLine className="h-4 w-4" />,
                    onSelect: () => {
                      window.open(
                        `/orders/anipo-barcode/reserve/${path}`,
                        "_blank",
                        "noopener,noreferrer",
                      );
                    },
                  },
                ]
              : []),
            ...(parcel?.barcode && parcel.canPrintLabel
              ? [
                  {
                    id: "tracking",
                    label: "رهگیری بسته",
                    icon: <Truck className="h-4 w-4" />,
                    onSelect: () => {
                      window.open(
                        `https://anipo.ir/checkconsignment/?code=${encodeURIComponent(parcel.barcode!)}`,
                        "_blank",
                        "noopener,noreferrer",
                      );
                    },
                  },
                ]
              : []),
          ]}
        />
      </div>
      {dialogOpen && parcel && (
        <AnipoBarcodeDialog
          isOpen
          onClose={() => setDialogOpen(false)}
          onGenerate={(weight, box) => run(false, weight, box)}
          loading={busy}
          initialWeight={parcel.weight}
          initialBoxSizeId={parcel.boxSizeId}
        />
      )}
    </>
  );
}
