"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiClient } from "@/services";
import AnipoBarcodeDialog from "./AnipoBarcodeDialog";
import { translateOrderLogMessage } from "@/utils/statusTranslations";
import SuperAdminOrderLogs from "./SuperAdminOrderLogs";
import { type OrderTimelineEvent } from "@/components/User/Orders/Detail/OrderTimeline";
import type { SuperAdminOrderDetail, SuperAdminOrderItem } from "@/types/super-admin/order";
import { useCan } from "@/hooks/useCan";
import toast from "react-hot-toast";
import { ORDER_LOGS_QUERY } from "./orderLogsQuery";
import { openPreInvoicePrintWindow } from "@/utils/preInvoiceTransfer";
import { getAnipoBarcodeUi } from "./anipoBarcodeUi";
import type { AnipoBarcodeWorkflowResponse } from "@/services/order";

interface SuperAdminOrderSidebarProps {
  orderData?: SuperAdminOrderDetail;
  selectedItems?: SuperAdminOrderItem[];
  shippingBarcode?: string;
  onReload?: () => void | Promise<void>;
}

type OrderLog = {
  id: number;
  attributes: {
    createdAt: string;
    Description?: string;
    Changes?: any;
  };
};

export default function SuperAdminOrderSidebar({
  orderData,
  selectedItems = [],
  shippingBarcode,
  onReload,
}: SuperAdminOrderSidebarProps = {}) {
  const { id } = useParams();
  const canViewOrderLogs = useCan("order.audit.read");
  const canViewAdminAudit = useCan("system.audit.read");
  const canPrint = useCan("order.print");
  const canManageShipping = useCan("order.shipping.manage");
  const [orderLogs, setOrderLogs] = useState<OrderLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [activeLogTab, setActiveLogTab] = useState<"events" | "audit">("events");
  const [readableEventCount, setReadableEventCount] = useState(0);
  const handleReadableEventsChange = useCallback((events: OrderTimelineEvent[]) => {
    setReadableEventCount(events.length);
  }, []);

  const timelineOrderId = orderData?.id ?? (id ? Number(id) : undefined);
  const [showBarcodeDialog, setShowBarcodeDialog] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [localWorkflow, setLocalWorkflow] = useState<{
    baseKey: string;
    result: AnipoBarcodeWorkflowResponse;
  } | null>(null);

  useEffect(() => {
    const fetchLogs = async () => {
      if (!id || !canViewOrderLogs) {
        setOrderLogs([]);
        setLogsLoading(false);
        return;
      }
      try {
        setLogsLoading(true);
        const res = await apiClient.get(
          ORDER_LOGS_QUERY(id) as any,
        );
        setOrderLogs(((res as any).data || []) as OrderLog[]);
      } catch (error) {
        console.error("Error fetching order logs:", error);
      } finally {
        setLogsLoading(false);
      }
    };
    fetchLogs();
  }, [id, canViewOrderLogs]);

  useEffect(() => {
    setReadableEventCount(0);
  }, [orderData?.id]);

  useEffect(() => {
    if (!canViewAdminAudit && canViewOrderLogs) setActiveLogTab("audit");
    if (canViewAdminAudit && !canViewOrderLogs) setActiveLogTab("events");
  }, [canViewAdminAudit, canViewOrderLogs]);

  const workflowBaseKey = [
    shippingBarcode || "",
    orderData?.anipoBarcodeState || "",
    orderData?.anipoLastCheckedAt || "",
  ].join("|");
  const workflowOverride =
    localWorkflow?.baseKey === workflowBaseKey ? localWorkflow.result : null;

  const barcode = workflowOverride?.barcode || shippingBarcode;
  const barcodeUi = getAnipoBarcodeUi({
    shippingBarcode: barcode,
    state: workflowOverride?.state || orderData?.anipoBarcodeState,
    orderStatus: orderData?.orderStatus,
    shippingMethodCode: orderData?.shippingMethodCode,
    providerMessage: workflowOverride?.message || orderData?.anipoLastMessage,
    lastError: orderData?.anipoLastError,
    reserveIsHeld: orderData?.reserveIsHeld,
    reserveExpiresAt: orderData?.reserveExpiresAt,
  });

  const applyWorkflowResponse = async (result: AnipoBarcodeWorkflowResponse) => {
    setLocalWorkflow({ baseKey: workflowBaseKey, result });
    if (result.issued && result.barcode) {
      toast.success(result.already ? "بارکد قبلاً صادر شده است" : "بارکد آنیپو صادر شد");
    } else {
      toast(result.message || "سفارش در انتظار تأیید آنیپو است");
    }
    await onReload?.();
  };

  const workflowErrorMessage = (error: unknown) => {
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
    if (!id) return;
    setIsGenerating(true);
    try {
      const mod = await import("@/services/order");
      const res = await mod.default.generateAnipoBarcode(Number(id), weight, boxSizeId);
      await applyWorkflowResponse(res);
      setShowBarcodeDialog(false);
    } catch (error) {
      toast.error(workflowErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCheckBarcode = async () => {
    if (!id) return;
    setIsGenerating(true);
    try {
      const mod = await import("@/services/order");
      const res = await mod.default.checkAnipoBarcode(Number(id));
      await applyWorkflowResponse(res);
    } catch (error) {
      toast.error(workflowErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  };

  const barcodeToneClasses = {
    green: "bg-green-50 text-green-600",
    amber: "bg-orange-50 text-orange-600 hover:bg-orange-100",
    red: "bg-red-50 text-red-700 hover:bg-red-100",
    slate: "bg-slate-100 text-slate-500",
  }[barcodeUi.tone];

  const handlePrintPreInvoice = () => {
    if (!orderData || selectedItems.length === 0) {
      toast.error("لطفاً ابتدا محصولات را اضافه کنید");
      return;
    }

    // Create a temporary order object in Strapi format for the Invoice component
    const tempOrder = {
      id: "temp-preview",
      attributes: {
        Date: orderData.orderDate?.toISOString() || new Date().toISOString(),
        createdAt: new Date().toISOString(),
        Description: orderData.description || "",
        ShippingCost: orderData.shipping || 0,
        user: {
          data: {
            attributes: {
              Phone: orderData.phoneNumber || "",
              user_info: {
                data: {
                  attributes: {
                    FirstName: orderData.userName?.split(" ")[0] || "",
                    LastName: orderData.userName?.split(" ").slice(1).join(" ") || "",
                  },
                },
              },
            },
          },
        },
        delivery_address: {
          data: {
            attributes: {
              FullAddress: orderData.address || "",
              PostalCode: orderData.postalCode || "",
            },
          },
        },
        order_items: {
          data: selectedItems.map((item, index) => ({
            id: index.toString(),
            attributes: {
              Count: item.quantity,
              PerAmount: item.price,
              ProductTitle: item.productName,
              ProductSKU: item.productCode,
            },
          })),
        },
        contract: {
          data: {
            attributes: {
              Amount: orderData.total || 0,
            },
          },
        },
      },
    };

    try {
      if (!openPreInvoicePrintWindow(tempOrder)) {
        toast.error("مرورگر باید از انتقال امن پیش‌فاکتور و باز کردن پنجره جدید پشتیبانی کند");
      }
    } catch (error) {
      toast.error("خطا در باز کردن پیش‌فاکتور");
    }
  };

  return (
    <div className="flex flex-col gap-3 md:sticky md:top-5">
      <div className="flex flex-col gap-3 rounded-2xl bg-white p-5">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col">
            <span className="text-foreground-primary text-lg">فاکتور</span>

            <span className="text-sm text-neutral-400">شماره فاکتور: 841649</span>
          </div>

          {canPrint && <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (id) {
                try {
                  window.open(`/orders/print/${id}`, "_blank", "noopener,noreferrer");
                } catch {
                  toast.error("خطا در باز کردن پنجره چاپ");
                }
              } else {
                toast.error("لطفاً ابتدا سفارش را ذخیره کنید");
              }
            }}
            className="flex h-11 w-full items-center justify-center gap-1 rounded-md bg-slate-100 md:h-10"
            type="button"
          >
            <span className="text-sm text-neutral-500">چاپ فاکتور</span>

            <PrintIcon />
          </button>}

          {/* Anipo Barcode Button - Full Width */}
          {canManageShipping && <div className="mt-2 flex w-full flex-col gap-1.5">
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!id) {
                    toast.error("لطفاً ابتدا سفارش را ذخیره کنید");
                  } else if (barcodeUi.action === "submit") {
                    setShowBarcodeDialog(true);
                  } else if (barcodeUi.action === "check") {
                    void handleCheckBarcode();
                  }
                }}
                disabled={isGenerating || barcodeUi.action === null}
                className={`flex w-full items-center justify-center gap-1 rounded-md py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${barcodeToneClasses}`}
                type="button"
              >
                <span className="text-sm">
                  {isGenerating ? "در حال بررسی آنیپو..." : barcodeUi.label}
                </span>
              </button>
              {barcodeUi.message ? (
                <span className="text-xs leading-5 text-slate-500">{barcodeUi.message}</span>
              ) : null}
          </div>}
        </div>
      </div>

      {(canViewAdminAudit || canViewOrderLogs) && (
        <div className="flex flex-col gap-3 rounded-2xl bg-white p-5">
          <div className="flex items-center justify-between">
            <span className="text-foreground-primary text-lg">رویدادهای سفارش و پیامک</span>
          </div>

          {/* Tabs for Events and Audit Logs */}
          <div className="flex gap-2 border-b border-neutral-200">
            {canViewAdminAudit && <button
              type="button"
              onClick={() => setActiveLogTab("events")}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                activeLogTab === "events"
                  ? "border-b-2 border-infinity-primary text-infinity-primary"
                  : "text-neutral-500 hover:text-neutral-700"
              }`}
            >
              رویدادها ({readableEventCount})
            </button>}
            {canViewOrderLogs && <button
              type="button"
              onClick={() => setActiveLogTab("audit")}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                activeLogTab === "audit"
                  ? "border-b-2 border-infinity-primary text-infinity-primary"
                  : "text-neutral-500 hover:text-neutral-700"
              }`}
            >
              لاگ‌های فنی ({orderLogs.length})
            </button>}
          </div>

          {activeLogTab === "events" && canViewAdminAudit ? (
            <SuperAdminOrderLogs
              orderId={timelineOrderId}
              hideHeader
              onEventsChange={handleReadableEventsChange}
            />
          ) : (
            <>
              {logsLoading ? (
                <div className="text-sm text-neutral-400">در حال بارگذاری...</div>
              ) : orderLogs.length === 0 ? (
                <div className="text-sm text-neutral-400">لاگی ثبت نشده است</div>
              ) : (
                <div className="flex max-h-[400px] flex-col gap-3 overflow-y-auto">
                  {orderLogs.map((log, index) => {
                    const date = new Date(log.attributes.createdAt);
                    const formattedDate = date.toLocaleDateString("fa-IR", {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                    });
                    const formattedTime = date.toLocaleTimeString("fa-IR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    });
                    const isEven = index % 2 === 0;

                    return (
                      <div
                        key={log.id}
                        className={`rounded-lg p-3 ${isEven ? "bg-blue-50" : "bg-purple-50"}`}
                      >
                        <div className="text-foreground-primary mb-1 text-sm">
                          {translateOrderLogMessage(log.attributes.Description) || "ثبت رویداد"}
                        </div>
                        {log.attributes.Changes && (
                          <pre className="mb-1 mt-1 whitespace-pre-wrap break-all text-xs text-neutral-500">
                            {JSON.stringify(log.attributes.Changes, null, 2)}
                          </pre>
                        )}
                        <div className="mt-1 text-xs text-neutral-500">
                          {formattedDate} در {formattedTime}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {canManageShipping && showBarcodeDialog && (
        <AnipoBarcodeDialog
          isOpen={showBarcodeDialog}
          onClose={() => setShowBarcodeDialog(false)}
          onGenerate={handleGenerateBarcode}
          loading={isGenerating}
          initialWeight={orderData?.shippingWeight}
          initialBoxSizeId={orderData?.shippingBoxSizeId}
        />
      )}
    </div>
  );
}

function PrintIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M6.5835 7.16667V3.83333C6.5835 3.37333 6.95683 3 7.41683 3H14.0835C14.5435 3 14.9168 3.37333 14.9168 3.83333V7.16667"
        stroke="#64748B"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.58333 14.6667H4.91667C3.99583 14.6667 3.25 13.9209 3.25 13V8.83335C3.25 7.91252 3.99583 7.16669 4.91667 7.16669H16.5833C17.5042 7.16669 18.25 7.91252 18.25 8.83335V13C18.25 13.9209 17.5042 14.6667 16.5833 14.6667H14.9167"
        stroke="#64748B"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M6.5835 12H14.9168V17.1667C14.9168 17.6267 14.5435 18 14.0835 18H7.41683C6.95683 18 6.5835 17.6267 6.5835 17.1667V12Z"
        stroke="#64748B"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5835 9.66667H7.41683"
        stroke="#64748B"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Removed unused PlusIcon
