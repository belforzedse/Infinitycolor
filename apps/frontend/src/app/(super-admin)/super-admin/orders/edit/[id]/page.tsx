"use client";

import UpsertPageContentWrapper from "@/components/SuperAdmin/UpsertPage/ContentWrapper/index";
import Footer from "@/components/SuperAdmin/Order/SummaryFooter";
import GatewayLogs from "@/components/SuperAdmin/Order/GatewayLogs";
import AdjustItemsPanel from "@/components/SuperAdmin/Order/AdjustItemsPanel";
import { config } from "./config";
import Sidebar from "@/components/SuperAdmin/Order/Sidebar";
import { useState, useEffect, useRef } from "react";
import { apiClient } from "@/services";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { useParams } from "next/navigation";
import toast from "react-hot-toast";
import { ProductCoverImage } from "@/types/Product";
import type { SuperAdminOrderDetail, SuperAdminOrderItem } from "@/types/super-admin/order";
import { unwrapCollection, unwrapEntity } from "@/utils/strapi";
import { getPaymentGatewayLabel } from "@/utils/paymentGateways";
import { translateOrderStatus } from "@/utils/statusTranslations";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";

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
    delivery_address?: {
      data: {
        id: string;
        attributes: {
          PostalCode?: string;
          FullAddress?: string;
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
          Status:
            | "Not Ready"
            | "Confirmed"
            | "Finished"
            | "Failed"
            | "Cancelled";
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
  const [data, setData] = useState<SuperAdminOrderDetail>();

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

  const load = () => {
    setLoading(true);
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
        const normalizedOrder = unwrapEntity(
          rawResponse?.data ?? rawResponse,
        ) as
          | (OrderResponse["attributes"] & {
              id?: string | number;
            } & Record<string, any>)
          | undefined;

        if (!normalizedOrder) {
          throw new Error("سفارش پیدا نشد");
        }

        const orderItemsRaw = unwrapCollection(
          (normalizedOrder as any).order_items,
        );
        const items: SuperAdminOrderItem[] = orderItemsRaw.map((rawItem: any) => {
          const item = unwrapEntity(rawItem);
          const productVariation = unwrapEntity(item?.product_variation);
          const variationColor = unwrapEntity(
            (productVariation as any)?.product_variation_color,
          );
          const variationSize = unwrapEntity(
            (productVariation as any)?.product_variation_size,
          );
          const variationModel = unwrapEntity(
            (productVariation as any)?.product_variation_model,
          );
          const product = unwrapEntity(productVariation?.product);
          const coverImage = unwrapEntity(product?.CoverImage);
          const color = unwrapEntity(item?.product_color);
          const size = unwrapEntity(item?.product_size);
          const model = unwrapEntity((item as any)?.product_variation_model);
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
            color: color?.Title || variationColor?.Title,
            size: size?.Title || variationSize?.Title,
            model: model?.Title || variationModel?.Title,
            image: imageUrl,
          };
        });

        const contract = unwrapEntity((normalizedOrder as any).contract);
        const contractTransactions = unwrapCollection(
          contract?.contract_transactions,
        ).map((tx: any) => unwrapEntity(tx));

        const shippingCost = Number(normalizedOrder?.ShippingCost || 0);
        const itemsSubtotal = (items || []).reduce(
          (sum: number, it: any) =>
            sum + Number(it.price || 0) * Number(it.quantity || 0),
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
        const lastSnappayTx = [...txList]
          .reverse()
          .find(
            (tx) =>
              (tx?.external_source || contract?.external_source) ===
                "SnappPay" && tx?.TrackId,
          );
        const rawPaymentGateway =
          unwrapEntity(lastTx?.payment_gateway)?.Title ||
          contract?.payment_gateway ||
          (normalizedOrder as any)?.PaymentGateway ||
          undefined;
        const paymentGateway = rawPaymentGateway
          ? getPaymentGatewayLabel(rawPaymentGateway)
          : undefined;
        const transactionId =
          contract?.external_id || (normalizedOrder as any)?.external_id;
        const paymentToken = lastSnappayTx?.TrackId;

        const userName =
          (userInfo?.FirstName || "") + " " + (userInfo?.LastName || "");

        setData({
          id: Number((normalizedOrder as any).id),
          createdAt: new Date(
            normalizedOrder?.createdAt ??
              normalizedOrder?.created_at ??
              Date.now(),
          ),
          updatedAt: new Date(
            normalizedOrder?.updatedAt ??
              normalizedOrder?.updated_at ??
              Date.now(),
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
          postalCode: addr?.PostalCode,
          paymentGateway,
          transactionId,
          paymentToken,
          shipping: shippingCost,
          shippingMethod,
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
        });
      })
      .catch((err) => {
        setError(err.response?.data?.error || "error");
        toast.error("خطایی رخ داده است");
      })
      .finally(() => {
        setLoading(false);
      });
  };

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

  // Note: Automatic polling has been disabled on the order edit page to prevent
  // conflicts when admins are making changes. The order data will update:
  // - When the admin manually refreshes the page
  // - After saving changes (onSuccess callback reloads data)
  // - After barcode operations
  useEffect(() => {
    // Polling disabled - prevents interrupting admin edits
    // Manual refresh or save operations will update the data
    return () => {
      // Cleanup placeholder
    };
  }, [id]);

  const performOrderUpdate = async (formData: SuperAdminOrderDetail) => {
    try {
      await apiClient.put(`/orders/${id}`, {
        data: {
          Status: formData.orderStatus,
          Description: formData.description,
          Note: formData.note,
        },
      });
      toast.success("سفارش با موفقیت ویرایش شد");
      // Reflect the saved status so a subsequent edit compares against fresh data.
      await load();
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

  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error: {error}</div>;
  }

  const isIrreversibleTarget = !!pendingStatusChange?.toStatus
    && IRREVERSIBLE_STATUSES.has(pendingStatusChange.toStatus);
  const statusChangeDescription = pendingStatusChange
    ? `وضعیت سفارش از «${translateOrderStatus(pendingStatusChange.fromStatus)}» به «${translateOrderStatus(
        pendingStatusChange.toStatus,
      )}» تغییر می‌کند.${
        isIrreversibleTarget
          ? " این تغییر ممکن است غیرقابل بازگشت باشد و به مشتری اطلاع‌رسانی شود. لطفاً مطمئن شوید."
          : ""
      }`
    : "";

  return (
    <>
      {data && <AdjustItemsPanel order={data} onSuccess={load} />}
      <ConfirmDialog
        isOpen={!!pendingStatusChange}
        title="تغییر وضعیت سفارش"
        description={statusChangeDescription}
        confirmText="تایید و ذخیره"
        cancelText="انصراف"
        onConfirm={confirmStatusChange}
        onCancel={cancelStatusChange}
      />
      <UpsertPageContentWrapper<SuperAdminOrderDetail>
        config={config}
        data={data}
        onSubmit={handleOrderSubmit}
        footer={
          <>
            <Footer order={data} onReload={load} />
            {data?.id ? <GatewayLogs orderId={data.id} /> : null}
          </>
        }
        customSidebar={<Sidebar shippingBarcode={data?.shippingBarcode} orderData={data} />}
      />
    </>
  );
}
