"use client";

import { useState } from "react";
import { useAtom } from "jotai";
import toast from "react-hot-toast";
import SuperAdminTableCellActionButton from "@/components/SuperAdmin/Table/Cells/ActionButton";
import { refreshTable } from "@/components/SuperAdmin/Table";
import EyeIcon from "@/components/SuperAdmin/Layout/Icons/EyeIcon";
import type { AnipoBarcodeWorkflowResponse } from "@/services/order";
import type { AnipoBarcodeState } from "@/types/super-admin/order";
import AnipoBarcodeDialog from "./AnipoBarcodeDialog";
import { getAnipoBarcodeUi } from "./anipoBarcodeUi";
import { useCan } from "@/hooks/useCan";

interface OrderRowActionsProps {
  orderId: string;
  orderStatus?: string;
  shippingMethodCode?: string;
  shippingBarcode?: string;
  shippingWeight?: number;
  shippingBoxSizeId?: number;
  anipoBarcodeState?: AnipoBarcodeState;
  anipoSubmittedAt?: string;
  anipoLastMessage?: string;
  anipoLastError?: string;
  /** Projected from the order's reserve group; the server enforces the hold. */
  reserveIsHeld?: boolean;
}

export default function OrderRowActions(props: OrderRowActionsProps) {
  const {
    orderId,
    orderStatus,
    shippingMethodCode,
    shippingBarcode,
    shippingWeight,
    shippingBoxSizeId,
    anipoBarcodeState,
    anipoSubmittedAt,
    anipoLastMessage,
    anipoLastError,
    reserveIsHeld,
  } = props;
  const [, setRefresh] = useAtom(refreshTable);
  const [showBarcodeDialog, setShowBarcodeDialog] = useState(false);
  const canManageShipping = useCan("order.shipping.manage");
  const canPrint = useCan("order.print");
  const [isWorking, setIsWorking] = useState(false);
  const workflowBaseKey = [
    shippingBarcode || "",
    anipoBarcodeState || "",
    anipoLastMessage || "",
    anipoLastError || "",
  ].join("|");
  const [localWorkflow, setLocalWorkflow] = useState<{
    baseKey: string;
    result: AnipoBarcodeWorkflowResponse;
  } | null>(null);
  const workflow = localWorkflow?.baseKey === workflowBaseKey ? localWorkflow.result : null;

  const ui = getAnipoBarcodeUi({
    shippingBarcode: workflow?.barcode || shippingBarcode,
    state: workflow?.state || anipoBarcodeState,
    submittedAt: workflow?.submittedAt || anipoSubmittedAt,
    orderStatus,
    shippingMethodCode,
    providerMessage: workflow?.message || anipoLastMessage,
    lastError: anipoLastError,
    reserveIsHeld,
  });

  const handlePrintReceipt = () => {
    window.open(`/orders/print/${orderId}`, "_blank", "noopener,noreferrer");
  };

  const applyResponse = (result: AnipoBarcodeWorkflowResponse) => {
    setLocalWorkflow({ baseKey: workflowBaseKey, result });
    if (result.issued && result.barcode) {
      toast.success(result.already ? "بارکد قبلاً صادر شده است" : "بارکد آنیپو صادر شد");
    } else {
      toast(result.message || "سفارش در انتظار تأیید آنیپو است");
    }
    setRefresh(true);
  };

  const errorMessage = (error: unknown) => {
    const value = error as {
      message?: unknown;
      response?: { data?: { message?: unknown } };
    };
    return typeof value?.response?.data?.message === "string"
      ? value.response.data.message
      : typeof value?.message === "string"
        ? value.message
        : "ارتباط با آنیپو ناموفق بود";
  };

  const handleGenerateBarcode = async (weight?: number, boxSizeId?: number) => {
    setIsWorking(true);
    try {
      const mod = await import("@/services/order");
      const result = await mod.default.generateAnipoBarcode(
        Number(orderId),
        weight,
        boxSizeId,
      );
      applyResponse(result);
      setShowBarcodeDialog(false);
    } catch (error) {
      toast.error(errorMessage(error));
      setRefresh(true);
    } finally {
      setIsWorking(false);
    }
  };

  const handleCheckBarcode = async () => {
    setIsWorking(true);
    try {
      const mod = await import("@/services/order");
      applyResponse(await mod.default.checkAnipoBarcode(Number(orderId)));
    } catch (error) {
      toast.error(errorMessage(error));
      setRefresh(true);
    } finally {
      setIsWorking(false);
    }
  };

  const toneClasses = {
    green: "bg-green-50 text-green-600",
    amber: "bg-orange-50 text-orange-600 hover:bg-orange-100",
    red: "bg-red-50 text-red-700 hover:bg-red-100",
    slate: "bg-slate-100 text-slate-500",
  }[ui.tone];

  return (
    <>
      <div
        data-testid="admin-order-row-actions"
        className="flex w-full min-w-0 flex-row-reverse flex-wrap items-center justify-end gap-2 p-1 lg:w-auto lg:flex-nowrap"
      >
        <SuperAdminTableCellActionButton
          variant="secondary"
          path={`/orders/edit/${orderId}`}
          icon={<EyeIcon />}
          testId="admin-order-view"
          dataAttributes={{ id: orderId }}
        />

        {canPrint ? <button
          onClick={handlePrintReceipt}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600 transition-colors hover:bg-blue-100"
          title="پرینت فاکتور"
          type="button"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6,9 6,2 18,2 18,9" />
            <path d="m6,18 h12" />
            <path d="m6,14 h12 v4 h-12 z" />
          </svg>
        </button> : null}

        {canManageShipping ? <button
          onClick={() => {
            if (ui.action === "submit") setShowBarcodeDialog(true);
            if (ui.action === "check") void handleCheckBarcode();
          }}
          disabled={isWorking || ui.action === null}
          className={`text-xs flex min-h-[32px] min-w-0 max-w-full items-center rounded-md px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-70 lg:max-w-[12rem] ${toneClasses}`}
          title={ui.message || ui.label}
          type="button"
        >
          <span className="min-w-0 break-words text-right leading-5 lg:truncate">
            {isWorking ? "در حال بررسی..." : ui.label}
          </span>
        </button> : null}
      </div>

      {canManageShipping && showBarcodeDialog ? (
        <AnipoBarcodeDialog
          isOpen
          onClose={() => setShowBarcodeDialog(false)}
          onGenerate={handleGenerateBarcode}
          loading={isWorking}
          initialWeight={shippingWeight}
          initialBoxSizeId={shippingBoxSizeId}
        />
      ) : null}
    </>
  );
}
