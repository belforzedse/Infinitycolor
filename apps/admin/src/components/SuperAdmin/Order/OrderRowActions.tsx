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

interface OrderRowActionsProps {
  orderId: string;
  orderStatus?: string;
  shippingMethodCode?: string;
  shippingBarcode?: string;
  shippingWeight?: number;
  shippingBoxSizeId?: number;
  anipoBarcodeState?: AnipoBarcodeState;
  anipoLastMessage?: string;
  anipoLastError?: string;
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
    anipoLastMessage,
    anipoLastError,
  } = props;
  const [, setRefresh] = useAtom(refreshTable);
  const [showBarcodeDialog, setShowBarcodeDialog] = useState(false);
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
    orderStatus,
    shippingMethodCode,
    providerMessage: workflow?.message || anipoLastMessage,
    lastError: anipoLastError,
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
      <div className="flex flex-row-reverse items-center gap-2 p-1">
        <SuperAdminTableCellActionButton
          variant="secondary"
          path={`/orders/edit/${orderId}`}
          icon={<EyeIcon />}
          testId="admin-order-view"
          dataAttributes={{ id: orderId }}
        />

        <button
          onClick={handlePrintReceipt}
          className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-50 text-blue-600 transition-colors hover:bg-blue-100"
          title="پرینت فاکتور"
          type="button"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6,9 6,2 18,2 18,9" />
            <path d="m6,18 h12" />
            <path d="m6,14 h12 v4 h-12 z" />
          </svg>
        </button>

        <button
          onClick={() => {
            if (ui.action === "submit") setShowBarcodeDialog(true);
            if (ui.action === "check") void handleCheckBarcode();
          }}
          disabled={isWorking || ui.action === null}
          className={`text-xs flex items-center gap-1 rounded-md px-3 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${toneClasses}`}
          title={ui.message || ui.label}
          type="button"
        >
          <span>{isWorking ? "در حال بررسی..." : ui.label}</span>
        </button>
      </div>

      {showBarcodeDialog ? (
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
