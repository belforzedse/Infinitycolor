"use client";

import UpsertPageContentWrapper from "@/components/SuperAdmin/UpsertPage/ContentWrapper/index";
import Footer from "@/components/SuperAdmin/Order/SummaryFooter";
import GatewayLogs from "@/components/SuperAdmin/Order/GatewayLogs";
import AdjustItemsPanel from "@/components/SuperAdmin/Order/AdjustItemsPanel";
import OrderStatusActions from "@/components/SuperAdmin/Order/OrderStatusActions";
import OrderAddressEditor, {
  type AddressUpdateResponse,
} from "@/components/SuperAdmin/Order/OrderAddressEditor";
import { config } from "./config";
import Sidebar from "@/components/SuperAdmin/Order/Sidebar";
import { useState, useEffect, useRef } from "react";
import { apiClient } from "@/services";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { useParams } from "next/navigation";
import toast from "react-hot-toast";
import { ProductCoverImage } from "@/types/Product";
import type {
  AnipoBarcodeState,
  SuperAdminOrderDetail,
  SuperAdminOrderItem,
} from "@/types/super-admin/order";
import { unwrapCollection, unwrapEntity } from "@/utils/strapi";
import {
  customVariantAttributes,
  findAttributeTerm,
  isColorAttribute,
  isModelAttribute,
  isSizeAttribute,
  variationAttributeTerms,
} from "@/utils/orderAttributes";
import { getPaymentGatewayLabel } from "@/utils/paymentGateways";
import {
  getOrderStatusMeta,
  translateOrderStatus,
} from "@/utils/statusTranslations";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import { useCan } from "@/hooks/useCan";
import { CopyableId, DetailHeader, StatusBadge } from "@/components/admin";
import { priceFormatter } from "@/utils/price";
import { formatFaRelativeDateTime } from "@/utils/formatFaRelativeDateTime";

// Status targets that are effectively irreversible (or trigger customer-facing
// notifications / refunds) and therefore warrant an explicit extra warning.
const IRREVERSIBLE_STATUSES = new Set(["Shipment", "Done", "Cancelled", "Returned"]);

type OrderResponse = {
  id: string;
  attributes: {
    createdAt: string;
    updatedAt: string;
    Description: string;
    Date: string;
    Status: string;
    ShippingCost: number;
    ShippingMethodCode?: string;
    ShippingMethodTitle?: string;
    ShippingBarcode?: string;
    ShippingPostPrice?: number;
    ShippingTax?: number;
    ShippingWeight?: number;
    ShippingBoxSizeId?: number;
    AnipoBarcodeState?: AnipoBarcodeState;
    AnipoSubmittedAt?: string;
    AnipoLastCheckedAt?: string;
    AnipoPollingDeadlineAt?: string;
    AnipoIssuedAt?: string;
    AnipoReadyToIssue?: boolean;
    AnipoProviderStatus?: string;
    AnipoLastMessage?: string;
    AnipoLastError?: string;
    AnipoRecipientRevision?: number;
    AnipoRecipientSyncedRevision?: number;
    AnipoRecipientSyncState?: "Pending" | "Synced" | "NeedsAttention";
    AnipoRecipientSyncAttempts?: number;
    AnipoRecipientSyncLastAttemptAt?: string;
    AnipoRecipientSyncLastError?: string;
    AnipoRecipientSyncedAt?: string;
    hasSharedReserveAddress?: boolean;
    delivery_address?: {
      data: {
        id: string;
        attributes: {
          PostalCode?: string;
          FullAddress?: string;
          FullName?: string;
          Phone?: string;
          shipping_city?: {
            data: {
              id: string;
              attributes: {
                Title?: string;
                shipping_province?: {
                  data: { id: string; attributes: { Title?: string } };
                };
              };
            };
          };
        };
      };
    };
    contract: {
      data: {
        attributes: {
          Amount: number;
          external_id?: string;
          external_source?: string;
          Status: "Not Ready" | "Confirmed" | "Finished" | "Failed" | "Cancelled";
          contract_transactions?: {
            data: Array<{
              id: string;
              attributes: {
                Type?: string;
                Status?: string;
                Date?: string;
                external_source?: string;
                TrackId?: string;
                payment_gateway?: {
                  data: { id: string; attributes: { Title?: string } };
                };
              };
            }>;
          };
        };
      };
    };
    user: {
      data: {
        id: string;
        attributes: {
          Phone: string;
          user_info: {
            data: {
              id: string;
              attributes: {
                FirstName: string;
                LastName: string;
              };
            };
          };
        };
      };
    };
    order_items: {
      data: {
        id: string;
        attributes: {
          Count: number;
          PerAmount: number;
          ProductTitle: string;
          ProductSKU: string;
          product_variation: {
            data: {
              id: string;
              attributes: {
                product: {
                  data: {
                    id: string;
                    attributes: {
                      CoverImage: ProductCoverImage;
                    };
                  };
                };
              };
            };
          };
          product_color: {
            data: {
              id: string;
              attributes: {
                Title: string;
              };
            };
          };
          product_size: {
            data: {
              id: string;
              attributes: {
                Title: string;
              };
            };
          };
        };
      }[];
    };
  };
};

export default function EditOrderPage() {
  const canChangeStatus = useCan("order.status.update");
  const canCancel = useCan("order.cancel");
  const canEditNotes = useCan("order.notes.update");
  const canEditAddress = useCan("order.address.update");
  const canAdjustItems = useCan("order.items.adjust");
  const canReadFinancials = useCan("order.financial.read");
  const canReadAudit = useCan("order.audit.read");
  const canCreateOrder = useCan("order.manual.create");
  const canManageUsers = useCan("system.users.manage");
  const [data, setData] = useState<SuperAdminOrderDetail>();
  const [addressEditorOpen, setAddressEditorOpen] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { id } = useParams();
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isPageVisibleRef = useRef(true);
  // Holds an edit awaiting status-change confirmation (H1). `resolve` lets the
  // generic upsert wrapper's submit promise settle on confirm or cancel.
  const [pendingStatusChange, setPendingStatusChange] = useState<{
    formData: SuperAdminOrderDetail;
    fromStatus?: string;
    toStatus?: string;
    resolve: () => void;
  } | null>(null);

  const load = (options: { silent?: boolean } = {}) => {
    const { silent = false } = options;
    if (!silent) {
      setLoading(true);
    }
    // Add cache-busting timestamp to ensure fresh data
    const cacheBuster = `_t=${Date.now()}`;
    const query = [
      "populate[user][populate][user_info]=true",
      "populate[contract][populate][contract_transactions][populate][payment_gateway]=true",
      "populate[order_items][populate][product_variation][populate][product][populate][CoverImage]=true",
      "populate[order_items][populate][product_variation][populate][product_variation_color]=true",
      "populate[order_items][populate][product_variation][populate][product_variation_size]=true",
      "populate[order_items][populate][product_variation][populate][product_variation_model]=true",
      "populate[order_items][populate][product_color]=true",
      "populate[order_items][populate][product_size]=true",
      "populate[delivery_address][populate][shipping_city][populate][shipping_province]=true",
      "populate[shipping]=true",
    ]
      .filter(Boolean)
      .join("&");

    return apiClient
      .get(`/orders/${id}?${query}&${cacheBuster}`)
      .then((res) => {
        const rawResponse = (res as any).data;
        const normalizedOrder = unwrapEntity(rawResponse?.data ?? rawResponse) as
          | (OrderResponse["attributes"] & {
              id?: string | number;
            } & Record<string, any>)
          | undefined;

        if (!normalizedOrder) {
          throw new Error("سفارش پیدا نشد");
        }

        const orderItemsRaw = unwrapCollection((normalizedOrder as any).order_items);
        const items: SuperAdminOrderItem[] = orderItemsRaw.map((rawItem: any) => {
          const item = unwrapEntity(rawItem);
          const productVariation = unwrapEntity(item?.product_variation);
          const variationColor = unwrapEntity((productVariation as any)?.product_variation_color);
          const variationSize = unwrapEntity((productVariation as any)?.product_variation_size);
          const variationModel = unwrapEntity((productVariation as any)?.product_variation_model);
          const product = unwrapEntity(productVariation?.product);
          const coverImage = unwrapEntity(product?.CoverImage);
          const color = unwrapEntity(item?.product_color);
          const size = unwrapEntity(item?.product_size);
          const model = unwrapEntity((item as any)?.product_variation_model);

          // Colour/size/model are only the three attributes with a relation column of
          // their own, and even they can live purely as a catalog term (a WooCommerce
          // colour taxonomy projects as LegacyProjection "None"), so each falls back
          // to its term. Everything else the variation carries — a «کد» design code
          // and the like — is just as much part of what was bought, so it is kept too.
          const attributeTerms = variationAttributeTerms(productVariation);
          const resolvedColor =
            color?.Title ||
            variationColor?.Title ||
            findAttributeTerm(attributeTerms, isColorAttribute)?.Title;
          const resolvedSize =
            size?.Title ||
            variationSize?.Title ||
            findAttributeTerm(attributeTerms, isSizeAttribute)?.Title;
          const resolvedModel =
            model?.Title ||
            variationModel?.Title ||
            findAttributeTerm(attributeTerms, isModelAttribute)?.Title;
          const customAttributes = customVariantAttributes(attributeTerms, [
            resolvedColor,
            resolvedSize,
            resolvedModel,
          ]);
          const thumbnailUrl =
            coverImage?.formats?.thumbnail?.url ??
            coverImage?.url ??
            coverImage?.data?.attributes?.url;

          // Construct image URL properly
          let imageUrl = "";
          if (thumbnailUrl) {
            imageUrl = resolveAssetUrl(thumbnailUrl);
          }

          return {
            id: Number(item?.id ?? item?.orderItemId ?? 0),
            productId: Number(productVariation?.id ?? product?.id ?? 0),
            productName: item?.ProductTitle ?? product?.Title ?? "",
            productCode: item?.ProductSKU ?? productVariation?.SKU ?? "",
            price: Number(item?.PerAmount ?? productVariation?.Price ?? 0),
            quantity: Number(item?.Count ?? 0),
            color: resolvedColor,
            size: resolvedSize,
            model: resolvedModel,
            customAttributes: customAttributes.length ? customAttributes : undefined,
            image: imageUrl,
          };
        });

        const contract = unwrapEntity((normalizedOrder as any).contract);
        const contractTransactions = unwrapCollection(contract?.contract_transactions).map(
          (tx: any) => unwrapEntity(tx),
        );

        const shippingCost = Number(normalizedOrder?.ShippingCost || 0);
        const itemsSubtotal = (items || []).reduce(
          (sum: number, it: any) => sum + Number(it.price || 0) * Number(it.quantity || 0),
          0,
        );
        const contractAmount = Number(contract?.Amount || 0);
        const taxPercent = Number(contract?.TaxPercent || 0);
        const subtotal = itemsSubtotal;
        const total = contractAmount || itemsSubtotal + shippingCost;
        const r = taxPercent / 100;
        const preTaxBase = (total - shippingCost) / (1 + r);
        const discount = Math.max(0, Math.round(subtotal - preTaxBase));
        const tax = Math.max(0, Math.round(preTaxBase * r));

        const user = unwrapEntity((normalizedOrder as any).user);
        const userInfo = unwrapEntity(user?.user_info);

        const addr = unwrapEntity((normalizedOrder as any).delivery_address);
        const city = unwrapEntity(addr?.shipping_city);
        const province = unwrapEntity(city?.shipping_province);
        const fullAddress = [addr?.FullAddress, city?.Title, province?.Title]
          .filter(Boolean)
          .join(" - ");

        const shippingEntity = unwrapEntity((normalizedOrder as any).shipping);
        const shippingMethod =
          normalizedOrder?.ShippingMethodTitle ||
          shippingEntity?.Name ||
          shippingEntity?.Title ||
          undefined;

        const txList = contractTransactions || [];
        const lastTx = txList[txList.length - 1];
        // SnappPay stores the provider payment token on the transaction's TrackId.
        // Operators need it verbatim to raise tickets with SnappPay support.
        const lastSnappayTx = [...txList]
          .reverse()
          .find(
            (tx: any) =>
              (tx?.external_source || contract?.external_source) === "SnappPay" && tx?.TrackId,
          );
        const rawPaymentGateway =
          unwrapEntity(lastTx?.payment_gateway)?.Title ||
          contract?.payment_gateway ||
          (normalizedOrder as any)?.PaymentGateway ||
          undefined;
        const paymentGateway = rawPaymentGateway
          ? getPaymentGatewayLabel(rawPaymentGateway)
          : undefined;
        const transactionId = contract?.external_id || (normalizedOrder as any)?.external_id;

        const userName = (userInfo?.FirstName || "") + " " + (userInfo?.LastName || "");
        const recipientName = String(addr?.FullName || userName).trim();
        const recipientPhone =
          addr?.Phone ||
          user?.Phone ||
          (user as any)?.phone ||
          (normalizedOrder as any)?.phone ||
          (normalizedOrder as any)?.Phone;

        setError(null);
        setData({
          id: Number((normalizedOrder as any).id),
          createdAt: new Date(
            normalizedOrder?.createdAt ?? normalizedOrder?.created_at ?? Date.now(),
          ),
          updatedAt: new Date(
            normalizedOrder?.updatedAt ?? normalizedOrder?.updated_at ?? Date.now(),
          ),
          description: normalizedOrder?.Description || "",
          note: normalizedOrder?.Note || undefined,
          orderDate: new Date(normalizedOrder?.Date ?? Date.now()),
          orderStatus: normalizedOrder?.Status,
          phoneNumber:
            user?.Phone ??
            (user as any)?.phone ??
            (normalizedOrder as any)?.phone ??
            (normalizedOrder as any)?.Phone,
          address: fullAddress || addr?.Description || undefined,
          addressLine: addr?.FullAddress || "",
          deliveryAddressId: Number(addr?.id || 0) || undefined,
          shippingCityId: Number(city?.id || 0) || undefined,
          shippingCityTitle: city?.Title,
          shippingProvinceId: Number(province?.id || 0) || undefined,
          shippingProvinceTitle: province?.Title,
          recipientName,
          recipientPhone,
          postalCode: addr?.PostalCode,
          paymentGateway,
          transactionId,
          paymentToken: lastSnappayTx?.TrackId ?? null,
          shipping: shippingCost,
          shippingMethod,
          shippingMethodCode:
            normalizedOrder?.ShippingMethodCode || shippingEntity?.Code || undefined,
          userId: String(user?.id ?? (normalizedOrder as any)?.userId ?? ""),
          userName: userName.trim() || String(user?.id ?? ""),
          items: items,
          subtotal,
          discount,
          tax,
          total,
          contractStatus: contract?.Status,
          shippingBarcode: normalizedOrder?.ShippingBarcode,
          shippingPostPrice: normalizedOrder?.ShippingPostPrice,
          shippingTax: normalizedOrder?.ShippingTax,
          shippingWeight: normalizedOrder?.ShippingWeight,
          shippingBoxSizeId: normalizedOrder?.ShippingBoxSizeId,
          anipoBarcodeState: normalizedOrder?.AnipoBarcodeState,
          anipoSubmittedAt: normalizedOrder?.AnipoSubmittedAt,
          anipoLastCheckedAt: normalizedOrder?.AnipoLastCheckedAt,
          anipoPollingDeadlineAt: normalizedOrder?.AnipoPollingDeadlineAt,
          anipoIssuedAt: normalizedOrder?.AnipoIssuedAt,
          anipoReadyToIssue: normalizedOrder?.AnipoReadyToIssue,
          anipoProviderStatus: normalizedOrder?.AnipoProviderStatus,
          anipoLastMessage: normalizedOrder?.AnipoLastMessage,
          anipoLastError: normalizedOrder?.AnipoLastError,
          anipoRecipientRevision: normalizedOrder?.AnipoRecipientRevision,
          anipoRecipientSyncedRevision: normalizedOrder?.AnipoRecipientSyncedRevision,
          anipoRecipientSyncState: normalizedOrder?.AnipoRecipientSyncState,
          anipoRecipientSyncAttempts: normalizedOrder?.AnipoRecipientSyncAttempts,
          anipoRecipientSyncLastAttemptAt: normalizedOrder?.AnipoRecipientSyncLastAttemptAt,
          anipoRecipientSyncLastError: normalizedOrder?.AnipoRecipientSyncLastError,
          anipoRecipientSyncedAt: normalizedOrder?.AnipoRecipientSyncedAt,
          isReserveOrder: (normalizedOrder as any)?.isReserveOrder,
          reserveGroupId: (normalizedOrder as any)?.reserveGroupId,
          hasSharedReserveAddress: Boolean((normalizedOrder as any)?.hasSharedReserveAddress),
          reserveState: (normalizedOrder as any)?.reserveState,
          reserveClosureReason: (normalizedOrder as any)?.reserveClosureReason,
          reserveExpiresAt: (normalizedOrder as any)?.reserveExpiresAt,
          reserveIsActive: (normalizedOrder as any)?.reserveIsActive,
          reserveIsHeld: (normalizedOrder as any)?.reserveIsHeld,
        });
      })
      .catch((err) => {
        if (silent) {
          return;
        }

        setError(err.response?.data?.error || "error");
        toast.error("خطایی رخ داده است");
      })
      .finally(() => {
        if (!silent) {
          setLoading(false);
        }
      });
  };

  const refreshAfterOrderAction = () => load({ silent: true });

  useEffect(() => {
    load();
  }, [id]);

  // Set up visibility change listener for page focus
  useEffect(() => {
    const handleVisibilityChange = () => {
      isPageVisibleRef.current = !document.hidden;
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Keep ordinary form polling disabled, but refresh the read-only carrier state
  // while a recipient correction is pending. Pause while the editor is open so
  // a refresh can never replace values the operator is typing.
  useEffect(() => {
    if (data?.anipoRecipientSyncState !== "Pending" || addressEditorOpen) return;
    pollingIntervalRef.current = setInterval(() => {
      if (isPageVisibleRef.current) void load({ silent: true });
    }, 8_000);
    return () => {
      if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    };
  }, [id, data?.anipoRecipientSyncState, addressEditorOpen]);

  const performOrderUpdate = async (formData: SuperAdminOrderDetail) => {
    try {
      await apiClient.put(`/orders/${id}/admin/notes`, {
        data: {
          Description: formData.description,
          Note: formData.note,
        },
      });
      toast.success("سفارش با موفقیت ویرایش شد");
      // Reflect the saved status so a subsequent edit compares against fresh data.
      await load({ silent: true });
    } catch (err) {
      toast.error("خطایی رخ داده است");
    }
  };

  const handleOrderSubmit = (formData: SuperAdminOrderDetail) => {
    const fromStatus = data?.orderStatus;
    const toStatus = formData.orderStatus;
    const statusChanged = !!toStatus && toStatus !== fromStatus;

    // Any status change is gated behind an explicit confirmation (H1) — it can
    // trigger customer notifications, refunds, or an irreversible state.
    if (statusChanged) {
      return new Promise<void>((resolve) => {
        setPendingStatusChange({ formData, fromStatus, toStatus, resolve });
      });
    }
    return performOrderUpdate(formData);
  };

  const confirmStatusChange = async () => {
    if (!pendingStatusChange) return;
    const { formData, resolve } = pendingStatusChange;
    await performOrderUpdate(formData);
    resolve();
    setPendingStatusChange(null);
  };

  const cancelStatusChange = () => {
    // Settle the submit promise without saving so the wrapper clears its loading state.
    pendingStatusChange?.resolve();
    setPendingStatusChange(null);
  };

  const handleAddressSaved = async (result: AddressUpdateResponse) => {
    if (result.noChange) {
      toast("تغییری ثبت نشد");
    } else if (result.carrierSync.status === "pending") {
      toast.success("نشانی ذخیره شد؛ همگام‌سازی آنیپو در حال انجام است");
    } else if (result.carrierSync.status === "needs_attention") {
      toast.error("نشانی ذخیره شد؛ همگام‌سازی آنیپو نیاز به بررسی دارد");
    } else {
      toast.success("اطلاعات گیرنده ذخیره شد");
    }
    await load({ silent: true });
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error: {error}</div>;
  }

  const isIrreversibleTarget =
    !!pendingStatusChange?.toStatus && IRREVERSIBLE_STATUSES.has(pendingStatusChange.toStatus);
  const statusChangeDescription = pendingStatusChange
    ? `وضعیت سفارش از «${translateOrderStatus(pendingStatusChange.fromStatus)}» به «${translateOrderStatus(
        pendingStatusChange.toStatus,
      )}» تغییر می‌کند.${
        isIrreversibleTarget
          ? " این تغییر ممکن است غیرقابل بازگشت باشد و به مشتری اطلاع‌رسانی شود. لطفاً مطمئن شوید."
          : ""
      }`
    : "";
  const pageConfig = {
    ...config,
    addButton: canCreateOrder ? config.addButton : undefined,
    actionButtons: canEditNotes ? config.actionButtons : () => null,
    config: config.config.map((group) => ({
      ...group,
      sections: group.sections.map((section) => ({
        ...section,
        fields: section.fields
          .filter(
            (field) =>
              canReadFinancials ||
              !("name" in field && ["paymentGateway", "transactionId"].includes(String(field.name))),
          )
          .map((field) => {
            if (!("name" in field)) return field;
            if (field.name === "userName" && !canManageUsers) {
              return { ...field, labelAction: undefined };
            }
            if (field.name === "address" && canEditAddress) {
              return {
                ...field,
                labelAction: () => (
                  <button
                    type="button"
                    className="text-sm font-medium text-actions-link"
                    onClick={() => setAddressEditorOpen(true)}
                  >
                    ویرایش اطلاعات گیرنده
                  </button>
                ),
              };
            }
            if (["description", "note"].includes(String(field.name)) && !canEditNotes) {
              return { ...field, readOnly: true };
            }
            return field;
          }),
      })),
    })),
  } as typeof config;

  const statusMeta = getOrderStatusMeta(data?.orderStatus);
  const buyerName = data?.userName?.trim();

  return (
    <div className="space-y-4 lg:space-y-6">
      {/*
        Reading order is deliberate and differs from before. The page used to
        open with the two most destructive controls on the screen (cancel order,
        which refunds and restocks, and the item-adjustment panel), show its own
        title ~600px down, and put the purchased items last. Now:
        header -> frequent status actions -> the actual items and totals ->
        details form -> rare/destructive operations.
      */}
      <DetailHeader
        backHref="/orders"
        backLabel="بازگشت به سفارشات"
        title={buyerName}
        titleFallback={data ? "بدون مشتری" : "…"}
        identifier={
          data ? <CopyableId value={data.id} label="کپی شماره سفارش" /> : null
        }
        badge={
          data ? (
            <StatusBadge label={statusMeta.label} tone={statusMeta.tone} />
          ) : null
        }
        summary={
          data
            ? [
                {
                  label: "مبلغ کل",
                  value: priceFormatter(data.total ?? 0, " تومان"),
                },
                {
                  label: "تاریخ ثبت",
                  value: formatFaRelativeDateTime(data.orderDate),
                },
                { label: "شماره تماس", value: data.phoneNumber || "—" },
                {
                  label: "روش پرداخت",
                  value: data.paymentGateway
                    ? getPaymentGatewayLabel(data.paymentGateway)
                    : "—",
                },
              ]
            : undefined
        }
      />

      {data && (
        <OrderStatusActions
          order={data}
          onSuccess={refreshAfterOrderAction}
          canChangeStatus={canChangeStatus}
          canCancel={canCancel}
        />
      )}

      {data?.anipoRecipientSyncState === "Pending" ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          اطلاعات گیرنده در آنیپو در حال همگام‌سازی است.
        </div>
      ) : null}
      {data?.anipoRecipientSyncState === "NeedsAttention" ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          اطلاعات گیرنده ذخیره شده، اما همگام‌سازی آنیپو هنوز انجام نشده است و دوباره تلاش می‌شود.
        </div>
      ) : null}
      {data?.anipoRecipientSyncState === "Synced" &&
      Number(data.anipoRecipientRevision || 0) > 0 ? (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          اطلاعات گیرنده با آنیپو همگام است.
        </div>
      ) : null}

      {/* Purchased items: the point of the page, previously rendered last. */}
      <Footer order={data} onReload={refreshAfterOrderAction} />

      <ConfirmDialog
        isOpen={!!pendingStatusChange}
        title="تغییر وضعیت سفارش"
        description={statusChangeDescription}
        confirmText="تأیید و ذخیره"
        cancelText="انصراف"
        onConfirm={confirmStatusChange}
        onCancel={cancelStatusChange}
      />

      {data ? (
        <OrderAddressEditor
          isOpen={addressEditorOpen}
          order={data}
          onClose={() => setAddressEditorOpen(false)}
          onSaved={handleAddressSaved}
        />
      ) : null}

      <UpsertPageContentWrapper<SuperAdminOrderDetail>
        config={pageConfig}
        data={data}
        onSubmit={handleOrderSubmit}
        customSidebar={
          <Sidebar
            shippingBarcode={data?.shippingBarcode}
            orderData={data}
            onReload={refreshAfterOrderAction}
          />
        }
      />

      {/*
        Rare, irreversible operations (item adjustment with refund-to-wallet,
        barcode voiding). Collapsed by default so they are reachable but never
        the first thing a phone user can hit.
      */}
      {data && canAdjustItems && (
        <details className="group rounded-2xl border border-slate-200 bg-white">
          <summary className="text-sm flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-3 px-4 font-medium text-slate-700 md:px-5">
            <span>عملیات پیشرفته سفارش</span>
            <span className="text-xs text-slate-400 transition-transform group-open:rotate-180">
              ▾
            </span>
          </summary>
          <div className="border-t border-slate-100 p-4 md:p-5">
            <AdjustItemsPanel order={data} onSuccess={refreshAfterOrderAction} />
          </div>
        </details>
      )}

      {canReadAudit && data?.id ? <GatewayLogs orderId={data.id} /> : null}
    </div>
  );
}
