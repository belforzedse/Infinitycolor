"use client";

import Image from "next/image";
import { useState, type CSSProperties } from "react";
import FactorchiBarcode from "./FactorchiBarcode";
import { DEFAULT_SITE_IDENTITY } from "@/services/site-identity";
import type { SiteIdentity } from "@/types/site-identity";
import { resolvePaymentGateway } from "@/utils/paymentGateways";

const INVOICE_PHONE = "01732525144";
const INVOICE_STORE_POSTAL_CODE = "4916976618";
const INVOICE_SITE_URL = "infinitycolor.co";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

type Relation<T> = {
  data?: {
    attributes?: T;
  } | null;
};

type InvoiceItem = {
  id: string;
  attributes: {
    Count?: number;
    PerAmount?: number;
    ProductTitle?: string;
    ProductSKU?: string;
    product_color?: Relation<{ Title?: string }>;
    product_size?: Relation<{ Title?: string }>;
    product_variation_model?: Relation<{ Title?: string }>;
  };
};

export type InvoiceOrder = {
  id: string;
  attributes: {
    Date?: string;
    createdAt?: string;
    Description?: string;
    Note?: string;
    ShippingCost?: number | string;
    ShippingMethodTitle?: string;
    PaymentMethod?: string;
    PaymentGateway?: string;
    paymentGateway?: string;
    transactionId?: string;
    gatewayTrackingCode?: string;
    DiscountCode?: string;
    AppliedDiscountAmount?: number | string;
    shipping?: Relation<{ Name?: string; Title?: string }>;
    user?: Relation<{
      Phone?: string;
      phone?: string;
      user_info?: Relation<{
        FirstName?: string;
        LastName?: string;
        NationalCode?: string;
      }> | null;
    }>;
    delivery_address?: Relation<{
      FullAddress?: string;
      PostalCode?: string;
    }>;
    contract?: Relation<{
      Amount?: number | string;
      TaxPercent?: number | string;
    }>;
    order_items?: {
      data?: InvoiceItem[];
    };
  };
};

type Props = {
  order: InvoiceOrder;
  identity?: SiteIdentity;
  isPreInvoice?: boolean;
};

const toNumber = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatDate = (value: Date | string | undefined) => {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";

  return date.toLocaleDateString("fa-IR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
};

const relationAttributes = <T,>(relation?: Relation<T>) => relation?.data?.attributes;

const textValue = (value: unknown) => String(value ?? "").trim();

const formatPriceAmount = (amount: number) =>
  new Intl.NumberFormat("en-US")
    .format(amount)
    .replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)]);

const invoicePaymentMethod = (...values: unknown[]) => {
  for (const value of values) {
    const text = textValue(value);
    if (!text) continue;
    if (text.toLowerCase() === "unknown") continue;

    const gateway = resolvePaymentGateway(text);
    if (!gateway) return text;

    switch (gateway.key) {
      case "zarinpal":
        return "پرداخت با درگاه زرین‌پال";
      case "mellat":
        return "پرداخت با درگاه بانک ملت";
      case "snappay":
        return "پرداخت با اسنپ‌پی";
      case "samankish":
        return "پرداخت با درگاه بانک سامان";
      case "wallet":
        return "پرداخت با کیف پول";
    }
  }

  return "نامشخص";
};

const productLabel = (item: InvoiceItem) => {
  const attributes = item.attributes ?? {};
  const variation = [
    relationAttributes(attributes.product_color)?.Title,
    relationAttributes(attributes.product_size)?.Title,
    relationAttributes(attributes.product_variation_model)?.Title,
  ]
    .map(textValue)
    .filter(Boolean)
    .join("، ");
  const title = textValue(attributes.ProductTitle) || "—";
  return `${title}${variation ? `، ${variation}` : ""}`;
};

function CustomerField({
  className,
  label,
  value,
}: {
  className?: string;
  label: string;
  value: string;
}) {
  if (!value) return null;
  return (
    <p className={className}>
      <strong>{label}</strong> {value}
    </p>
  );
}

function Price({ amount }: { amount: number }) {
  return (
    <span className="woocommerce-Price-amount amount">
      <bdi>
        {formatPriceAmount(amount)} <span className="woocommerce-Price-currencySymbol">تومان</span>
      </bdi>
    </span>
  );
}

export default function Invoice({
  order,
  identity = DEFAULT_SITE_IDENTITY,
  isPreInvoice = false,
}: Props) {
  const [printDate] = useState(() => new Date());
  const attributes = order.attributes;
  const items = attributes.order_items?.data ?? [];
  const user = relationAttributes(attributes.user);
  const userInfo = relationAttributes(user?.user_info ?? undefined);
  const address = relationAttributes(attributes.delivery_address);
  const contract = relationAttributes(attributes.contract);
  const shipping = relationAttributes(attributes.shipping);

  const fullName = [userInfo?.FirstName, userInfo?.LastName]
    .map(textValue)
    .filter(Boolean)
    .join(" ");
  const phone = textValue(user?.Phone ?? user?.phone);
  const orderDate = formatDate(attributes.Date ?? attributes.createdAt);
  const paymentMethod = invoicePaymentMethod(
    attributes.PaymentMethod,
    attributes.paymentGateway,
    attributes.PaymentGateway,
  );
  const trackingCode = textValue(attributes.gatewayTrackingCode || attributes.transactionId);
  const shippingMethod = textValue(
    attributes.ShippingMethodTitle ?? shipping?.Name ?? shipping?.Title,
  );
  const subtotal = items.reduce(
    (sum, item) => sum + toNumber(item.attributes?.PerAmount) * toNumber(item.attributes?.Count),
    0,
  );
  const discount = toNumber(attributes.AppliedDiscountAmount);
  const shippingCost = toNumber(attributes.ShippingCost);
  const calculatedTotal = Math.max(0, subtotal - discount + shippingCost);
  const hasContractTotal = contract?.Amount !== undefined && contract?.Amount !== null;
  const total = hasContractTotal ? toNumber(contract.Amount) : calculatedTotal;
  const tax = Math.max(0, total - calculatedTotal);

  const primaryStore =
    identity.stores.find((store) => textValue(store.address)) ?? identity.stores[0];
  const storeAddress = textValue(primaryStore?.address);
  const storePostalCode = textValue(primaryStore?.postalCode) || INVOICE_STORE_POSTAL_CODE;
  const orderId = textValue(order.id);
  const hasBarcode = Boolean(orderId && orderId !== "temp-preview");
  const missingValue = isPreInvoice ? "----" : "";

  return (
    <article
      dir="rtl"
      className={`${
        isPreInvoice ? "pre-invoice" : "invoice"
      } rtl classic factorchi-document fc-print-a5 fc-compact-texts`}
      data-testid="invoice-document"
    >
      <div className="fc-document-frame" style={{ "--fc-doc-pad": "10px" } as CSSProperties}>
        <div className="classic container">
          {isPreInvoice ? <div className="fc-document-type">پیش‌فاکتور</div> : null}

          <table className="shop-detail fci-res-table fci-form-table" aria-label="اطلاعات فروشگاه">
            <tbody>
              <tr>
                <td>
                  <p className="shop-title">{identity.siteName}</p>
                  {hasBarcode ? (
                    <div className="fc-shop-barcode-title">
                      <div className="barcode">
                        <FactorchiBarcode value={orderId} height={60} />
                      </div>
                    </div>
                  ) : null}
                </td>
                <td className="fc-shop-logo-cell">
                  <div className="fc-shop-logo-row">
                    <Image
                      src="/images/cropped-021.webp"
                      alt={identity.siteName}
                      width={305}
                      height={191}
                      className="shop-logo"
                      priority
                    />
                  </div>
                </td>
                <td className="shop-meta-dates">
                  <span className="print-date section">
                    <span className="title">تاریخ چاپ:</span> {formatDate(printDate)}
                  </span>
                  <span className="order-id section">
                    <span className="title">شناسه سفارش:</span>{" "}
                    {hasBarcode ? orderId : missingValue || "—"}
                  </span>
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>
                  <div className="fc-shop-meta-line is-long">
                    <CustomerField className="shop-address" label="آدرس:" value={storeAddress} />
                    <div className="fc-shop-contacts">
                      <CustomerField
                        className="shop-url"
                        label="سایت:"
                        value={INVOICE_SITE_URL}
                      />
                      <CustomerField className="shop-phone" label="تلفن:" value={INVOICE_PHONE} />
                      <CustomerField
                        className="shop-postcode"
                        label="کدپستی:"
                        value={storePostalCode}
                      />
                    </div>
                  </div>
                </td>
              </tr>
            </tfoot>
          </table>

          <div className="customer-detail fc-party-compact" aria-label="اطلاعات خریدار">
            <div className="fc-customer-meta-line is-long">
              <CustomerField
                className="customer-address"
                label="آدرس:"
                value={textValue(address?.FullAddress) || missingValue}
              />
              <div className="fc-customer-contacts">
                <CustomerField
                  className="customer-name"
                  label="نام:"
                  value={fullName || missingValue}
                />
                <CustomerField
                  className="customer-phone"
                  label="تلفن:"
                  value={phone || missingValue}
                />
                <CustomerField
                  className="customer-postcode"
                  label="کدپستی:"
                  value={textValue(address?.PostalCode) || missingValue}
                />
                <CustomerField
                  className="shipping-method"
                  label="روش ارسال:"
                  value={shippingMethod}
                />
              </div>
            </div>
          </div>

          <table
            className="factorchi-products-table fci-fix-table products-table"
            aria-label="اقلام سفارش"
          >
            <thead>
              <tr>
                <th>محصول</th>
                <th>تعداد</th>
                <th>مبلغ</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const quantity = toNumber(item.attributes?.Count);
                const amount = toNumber(item.attributes?.PerAmount) * quantity;
                return (
                  <tr key={item.id}>
                    <td className="fc-product-cell">
                      <div className="fc-product-row">
                        <span className="fc-product-text">{productLabel(item)}</span>
                      </div>
                    </td>
                    <td className="fc-cell-qty">{quantity}</td>
                    <td className="fc-cell-price">
                      <Price amount={amount} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="fc-invoice-footer-row">
            <div className="fc-invoice-footer-total">
              <table
                className="factorchi-total-table fci-fix-table total-table"
                aria-label="جمع فاکتور"
              >
                <tbody>
                  <tr>
                    <td>جمع جزء</td>
                    <td className="fc-cell-price">
                      <Price amount={subtotal} />
                    </td>
                  </tr>
                  {discount > 0 ? (
                    <tr>
                      <td>تخفیف</td>
                      <td className="fc-cell-price">
                        <Price amount={discount} />
                      </td>
                    </tr>
                  ) : null}
                  {shippingCost > 0 ? (
                    <tr>
                      <td>هزینه ارسال</td>
                      <td className="fc-cell-price">
                        <Price amount={shippingCost} />
                      </td>
                    </tr>
                  ) : null}
                  {tax > 0 ? (
                    <tr>
                      <td>مالیات</td>
                      <td className="fc-cell-price">
                        <Price amount={tax} />
                      </td>
                    </tr>
                  ) : null}
                  <tr className="final">
                    <td>جمع کل</td>
                    <td className="fc-cell-price">
                      <Price amount={total} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {hasBarcode ? (
              <div className="fc-invoice-footer-barcode">
                <div className="barcode">
                  <FactorchiBarcode value={orderId} height={60} />
                  <span className="barcode-text">{orderId}</span>
                </div>
              </div>
            ) : null}
          </div>

          <div className="fc-invoice-tearoff">
            <div className="fc-invoice-tearoff-cut" aria-hidden="true" />
            <div className="fc-invoice-tearoff-fields">
              <p className="fc-tearoff-item fc-tearoff-payment">
                <strong>روش پرداخت:</strong> {paymentMethod}
              </p>
              {trackingCode ? (
                <p className="fc-tearoff-item fc-tearoff-tracking">
                  <strong>کدپیگیری درگاه:</strong> {trackingCode}
                </p>
              ) : null}
              {orderDate ? (
                <p className="fc-tearoff-item fc-tearoff-order-date">
                  <strong>تاریخ سفارش:</strong> {orderDate}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
