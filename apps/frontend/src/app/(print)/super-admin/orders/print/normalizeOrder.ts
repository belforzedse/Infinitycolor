import { unwrapCollection, unwrapEntity } from "@/utils/strapi";
import { resolvePaymentGateway, type PaymentGatewayKey } from "@/utils/paymentGateways";

const CANONICAL_GATEWAY_VALUES: Record<PaymentGatewayKey, string> = {
  zarinpal: "ZarinPal",
  mellat: "Mellat",
  snappay: "SnappPay",
  samankish: "SamanKish",
  wallet: "Wallet",
};

const textValue = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
};

type GatewayIdentity = {
  key?: PaymentGatewayKey;
  value?: string;
};

const resolveGatewayIdentity = (...values: unknown[]): GatewayIdentity => {
  let fallbackValue: string | undefined;

  for (const value of values) {
    const normalized = textValue(value);
    if (!normalized) continue;
    if (!fallbackValue && normalized.toLowerCase() !== "unknown") {
      fallbackValue = normalized;
    }
    const gateway = resolvePaymentGateway(normalized);
    if (gateway) {
      return {
        key: gateway.key,
        value: CANONICAL_GATEWAY_VALUES[gateway.key],
      };
    }
  }

  return { value: fallbackValue };
};

const transactionGatewayIdentity = (
  transaction: ReturnType<typeof unwrapEntity>,
): GatewayIdentity => {
  const gatewayRelation = unwrapEntity(transaction?.payment_gateway);
  return resolveGatewayIdentity(
    transaction?.external_source,
    gatewayRelation?.Code,
    gatewayRelation?.Title,
    transaction?.PaymentGateway,
  );
};

const transactionStatus = (transaction: ReturnType<typeof unwrapEntity>) =>
  textValue(transaction?.Status)?.toLowerCase();

const isSuccessfulTransaction = (transaction: ReturnType<typeof unwrapEntity>) =>
  transactionStatus(transaction) === "success";

const isFailedTransaction = (transaction: ReturnType<typeof unwrapEntity>) =>
  transactionStatus(transaction) === "failed";

const isGatewayTransaction = (transaction: ReturnType<typeof unwrapEntity>) => {
  const type = textValue(transaction?.Type)?.toLowerCase();
  if (type && type !== "gateway") return false;
  const gatewayRelation = unwrapEntity(transaction?.payment_gateway);
  return Boolean(
    type === "gateway" ||
      transactionGatewayIdentity(transaction).key ||
      textValue(gatewayRelation?.Title),
  );
};

const transactionTimestamp = (transaction: ReturnType<typeof unwrapEntity>) => {
  const value =
    transaction?.SettledAt ??
    transaction?.VerifiedAt ??
    transaction?.Date ??
    transaction?.updatedAt ??
    transaction?.createdAt;
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(timestamp) ? Number(transaction?.id ?? 0) : timestamp;
};

const selectInvoiceTransaction = (
  transactions: unknown[],
  preferredGateway?: PaymentGatewayKey,
) => {
  const latestFirst = transactions
    .map((transaction) => unwrapEntity(transaction))
    .filter(Boolean)
    .sort((left, right) => transactionTimestamp(right) - transactionTimestamp(left));
  const gatewayTransactions = latestFirst.filter(isGatewayTransaction);
  const candidates = gatewayTransactions.length ? gatewayTransactions : latestFirst;
  const gatewayMatches = (transaction: ReturnType<typeof unwrapEntity>) =>
    Boolean(preferredGateway && transactionGatewayIdentity(transaction).key === preferredGateway);

  const successful = candidates.filter(isSuccessfulTransaction);
  if (successful.length) {
    return successful.find(gatewayMatches) ?? successful[0];
  }

  const preferredTransactions = candidates.filter(gatewayMatches);
  return (
    preferredTransactions.find((transaction) => !isFailedTransaction(transaction)) ??
    preferredTransactions[0] ??
    candidates.find((transaction) => !isFailedTransaction(transaction)) ??
    candidates[0]
  );
};

const resolveInvoicePaymentDetails = ({
  attributesSource,
  contractEntity,
  normalizedOrder,
  transactions,
}: {
  attributesSource: NonNullable<ReturnType<typeof unwrapEntity>>;
  contractEntity: ReturnType<typeof unwrapEntity>;
  normalizedOrder: NonNullable<ReturnType<typeof unwrapEntity>>;
  transactions: unknown[];
}) => {
  const contractGateway = unwrapEntity(contractEntity?.payment_gateway);
  const preferredGateway = resolveGatewayIdentity(
    attributesSource.PaymentGateway,
    normalizedOrder.PaymentGateway,
    attributesSource.external_source,
    normalizedOrder.external_source,
    contractEntity?.external_source,
    contractGateway?.Code,
    contractGateway?.Title,
  );
  const invoiceTransaction = selectInvoiceTransaction(transactions, preferredGateway.key);
  const transactionGateway = transactionGatewayIdentity(invoiceTransaction);
  const gateway = transactionGateway.key
    ? transactionGateway
    : preferredGateway.key
      ? preferredGateway
      : transactionGateway.value
        ? transactionGateway
        : preferredGateway;
  const gatewayKey = gateway.key;
  const paymentGateway = gateway.value;

  const transactionIsSuccessful = isSuccessfulTransaction(invoiceTransaction);
  const orderIsPaid = ["started", "shipment", "done"].includes(
    textValue(attributesSource.Status ?? normalizedOrder.Status)?.toLowerCase() ?? "",
  );
  const settledFallback = orderIsPaid
    ? textValue(
        attributesSource.external_id ?? normalizedOrder.external_id ?? contractEntity?.external_id,
      )
    : undefined;

  let finalReference: string | undefined;
  if (transactionIsSuccessful) {
    switch (gatewayKey) {
      case "zarinpal":
        finalReference =
          textValue(invoiceTransaction?.GatewayRefId) ??
          textValue(invoiceTransaction?.external_id) ??
          settledFallback;
        break;
      case "mellat":
        finalReference =
          textValue(invoiceTransaction?.external_id) ??
          textValue(invoiceTransaction?.GatewayRefId) ??
          settledFallback;
        break;
      case "samankish":
        finalReference =
          textValue(invoiceTransaction?.TrackId) ??
          textValue(invoiceTransaction?.GatewayRefId) ??
          textValue(invoiceTransaction?.external_id) ??
          settledFallback;
        break;
      case "snappay":
        // TrackId is the SnappPay payment token. It is never an invoice reference.
        finalReference =
          textValue(invoiceTransaction?.external_id) ??
          textValue(invoiceTransaction?.GatewayRefId) ??
          settledFallback;
        break;
      case "wallet":
        finalReference =
          textValue(invoiceTransaction?.external_id) ??
          textValue(invoiceTransaction?.GatewayRefId) ??
          textValue(invoiceTransaction?.TrackId) ??
          settledFallback;
        break;
      default:
        finalReference =
          textValue(invoiceTransaction?.GatewayRefId) ??
          textValue(invoiceTransaction?.external_id) ??
          textValue(invoiceTransaction?.TrackId) ??
          settledFallback;
    }
  } else {
    // Pending gateway identifiers are redirect tokens/authorities, not receipts.
    finalReference = settledFallback;
  }

  return {
    paymentGateway,
    transactionId: finalReference,
    gatewayTrackingCode: finalReference,
  };
};

const normalizeUserRelation = (user: unknown) => {
  const entity = unwrapEntity(user);
  if (!entity) return undefined;

  // Handle user_info in different possible formats
  let userInfo: ReturnType<typeof unwrapEntity>;
  // Check if user_info exists and is not null
  if (entity.user_info != null) {
    // Try unwrapping if it's in Strapi format
    userInfo = unwrapEntity(entity.user_info);
    // If unwrapEntity didn't change it, it might already be unwrapped
    if (userInfo === entity.user_info && entity.user_info?.data) {
      // Try accessing the nested structure directly
      const nested = unwrapEntity(entity.user_info.data);
      if (nested) userInfo = nested;
    }
  }

  return {
    data: {
      id: String(entity.id ?? ""),
      attributes: {
        Phone: entity.Phone ?? entity.phone ?? "",
        // Preserve null structure if user_info was null, otherwise set to undefined if no data
        user_info:
          userInfo && (userInfo.FirstName || userInfo.LastName || userInfo.NationalCode)
            ? {
                data: {
                  id: String(userInfo.id ?? ""),
                  attributes: {
                    FirstName: userInfo.FirstName ?? "",
                    LastName: userInfo.LastName ?? "",
                    NationalCode: userInfo.NationalCode ?? "",
                  },
                },
              }
            : entity.user_info === null
              ? null
              : undefined,
      },
    },
  };
};

const normalizeOrderItems = (items: unknown) => {
  const collection = unwrapCollection(items);
  return {
    data: collection
      .map((item: unknown) => {
        const entity = unwrapEntity(item);
        if (!entity) return null;
        const pv = unwrapEntity(entity.product_variation);
        const product = unwrapEntity(pv?.product);
        const color = unwrapEntity(entity.product_color ?? pv?.product_variation_color);
        const size = unwrapEntity(entity.product_size ?? pv?.product_variation_size);
        const model = unwrapEntity(entity.product_variation_model ?? pv?.product_variation_model);
        // Order items only ever snapshot color/size/model. A variation whose sole
        // dimension is a generic attribute (e.g. "pattern") has none of those, so
        // without this the invoice silently drops the only variant info it has.
        const genericTerms = unwrapCollection(pv?.selected_attribute_terms)
          .map((term: unknown) => unwrapEntity(term)?.Title)
          .filter((title: unknown): title is string => Boolean(title));
        return {
          id: String(entity.id ?? ""),
          attributes: {
            Count: Number(entity.Count ?? entity.Quantity ?? 1),
            PerAmount: Number(entity.PerAmount ?? entity.UnitPrice ?? 0),
            ProductSKU: entity.ProductSKU ?? pv?.SKU ?? "—",
            ProductTitle: entity.ProductTitle ?? product?.Title ?? "—",
            product_color: color
              ? {
                  data: {
                    id: String(color.id ?? ""),
                    attributes: color,
                  },
                }
              : undefined,
            product_size: size
              ? {
                  data: {
                    id: String(size.id ?? ""),
                    attributes: size,
                  },
                }
              : undefined,
            product_variation_model: model
              ? {
                  data: {
                    id: String(model.id ?? ""),
                    attributes: model,
                  },
                }
              : undefined,
            genericAttributeLabel: !color && !size && !model && genericTerms.length
              ? genericTerms.join("، ")
              : undefined,
          },
        };
      })
      .filter(Boolean),
  };
};

const normalizeDeliveryAddress = (address: unknown) => {
  const entity = unwrapEntity(address);
  if (!entity) return undefined;
  const city = unwrapEntity(entity.shipping_city);
  const province = unwrapEntity(city?.shipping_province);
  const rawAddress = String(entity.FullAddress ?? entity.Description ?? "").trim();
  const addressPrefix = [province?.Title, city?.Title].filter((part): part is string =>
    Boolean(part && !rawAddress.includes(String(part))),
  );
  const fullAddress = [...addressPrefix, rawAddress].filter(Boolean).join("، ");
  return {
    data: {
      id: String(entity.id ?? ""),
      attributes: {
        ...entity,
        FullAddress: fullAddress || entity.FullAddress,
        shipping_city: city
          ? {
              data: {
                id: String(city.id ?? ""),
                attributes: {
                  ...city,
                  shipping_province: province
                    ? {
                        data: {
                          id: String(province.id ?? ""),
                          attributes: province,
                        },
                      }
                    : undefined,
                },
              },
            }
          : undefined,
      },
    },
  };
};

const normalizeShipping = (shipping: unknown) => {
  const entity = unwrapEntity(shipping);
  if (!entity) return undefined;
  return {
    data: {
      id: String(entity.id ?? ""),
      attributes: {
        ...entity,
        Name: entity.Name ?? entity.Title ?? entity.name ?? "",
      },
    },
  };
};

const normalizeContract = (contract: unknown) => {
  const entity = unwrapEntity(contract);
  if (!entity) return undefined;
  const transactions = unwrapCollection(entity.contract_transactions).map((tx: unknown) => {
    const txEntity = unwrapEntity(tx);
    const gateway = unwrapEntity(txEntity?.payment_gateway);
    const safeTransaction = { ...txEntity };
    if (transactionGatewayIdentity(txEntity).key === "snappay") {
      delete safeTransaction.TrackId;
    }
    return {
      id: String(txEntity?.id ?? ""),
      attributes: {
        ...safeTransaction,
        payment_gateway: gateway
          ? {
              data: {
                id: String(gateway.id ?? ""),
                attributes: gateway,
              },
            }
          : undefined,
      },
    };
  });
  return {
    data: {
      id: String(entity.id ?? ""),
      attributes: {
        ...entity,
        contract_transactions: {
          data: transactions,
        },
      },
    },
  };
};

export const normalizeOrderForInvoice = (raw: unknown, fallbackId?: string) => {
  const normalizedOrder = unwrapEntity(raw);
  if (!normalizedOrder) return null;

  const attributesSource = normalizedOrder.attributes
    ? { ...normalizedOrder.attributes }
    : { ...normalizedOrder };

  const contractEntity = unwrapEntity(attributesSource.contract ?? normalizedOrder.contract);
  const contractTransactions = unwrapCollection(contractEntity?.contract_transactions);
  const paymentDetails = resolveInvoicePaymentDetails({
    attributesSource,
    contractEntity,
    normalizedOrder,
    transactions: contractTransactions,
  });

  const normalizedOrderItems = normalizeOrderItems(
    attributesSource.order_items ?? normalizedOrder.order_items,
  );
  const normalizedUser = normalizeUserRelation(attributesSource.user ?? normalizedOrder.user);
  const normalizedDeliveryAddress = normalizeDeliveryAddress(
    attributesSource.delivery_address ?? normalizedOrder.delivery_address,
  );
  const normalizedShipping = normalizeShipping(
    attributesSource.shipping ?? normalizedOrder.shipping,
  );
  const normalizedContract = normalizeContract(
    attributesSource.contract ?? normalizedOrder.contract,
  );

  const finalAttributes = {
    ...attributesSource,
    ...paymentDetails,
    user: normalizedUser ?? attributesSource.user,
    contract: normalizedContract ?? attributesSource.contract,
    order_items: normalizedOrderItems,
    delivery_address: normalizedDeliveryAddress ?? attributesSource.delivery_address,
    shipping: normalizedShipping ?? attributesSource.shipping,
  };

  return {
    id: String(normalizedOrder.id ?? attributesSource.id ?? fallbackId ?? ""),
    attributes: finalAttributes,
  };
};
