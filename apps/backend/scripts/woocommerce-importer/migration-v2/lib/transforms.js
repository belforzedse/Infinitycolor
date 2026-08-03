"use strict";

const {
  wooSourceTimestamps,
  wordpressSourceTimestamps,
} = require("../../utils/sourceTimestamps");

function toEnglishDigits(value) {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function canonicalPhone(value) {
  let phone = toEnglishDigits(value).replace(/[^\d+]/g, "");
  if (phone.startsWith("0098")) phone = `+98${phone.slice(4)}`;
  else if (phone.startsWith("98")) phone = `+${phone}`;
  else if (phone.startsWith("09")) phone = `+98${phone.slice(1)}`;
  else if (phone.startsWith("9")) phone = `+98${phone}`;
  return /^\+989\d{9}$/.test(phone) ? phone : null;
}

function decimalToInteger(value, multiplier = 10) {
  const raw = toEnglishDigits(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error("MONEY_FORMAT_INVALID");
  const [whole, fraction = ""] = raw.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`) * BigInt(multiplier);
  if (numerator % scale !== 0n) throw new Error("MONEY_NOT_EXACT_AFTER_CONVERSION");
  return (numerator / scale).toString();
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function rendered(value) {
  return typeof value === "object" && value !== null ? String(value.rendered || "") : String(value || "");
}

function customerPayload(customer) {
  const phone = canonicalPhone(customer?.billing?.phone || customer?.shipping?.phone);
  if (!phone) throw new Error("USER_PHONE_INVALID");
  const sourceTimestamps = wooSourceTimestamps(customer);
  return {
    sourceId: String(customer.id),
    phone,
    email: cleanText(customer.email, 255) || null,
    firstName: cleanText(customer.first_name, 255),
    lastName: cleanText(customer.last_name, 255),
    ...(sourceTimestamps ? {
      sourceCreatedAt: sourceTimestamps.createdAt,
      sourceUpdatedAt: sourceTimestamps.updatedAt,
    } : {}),
  };
}

function walletPayload(walletUser) {
  const sourceId = String(walletUser?.id || "");
  if (!/^\d+$/.test(sourceId) || sourceId === "0") throw new Error("WALLET_USER_ID_INVALID");
  return {
    userSourceId: sourceId,
    balanceRial: decimalToInteger(walletUser.balance ?? 0, 10),
  };
}

function walletBalanceValue(response) {
  const candidates = [
    response?.balance,
    response?.balance_base,
    response?.data?.balance,
    response?.data?.balance_base,
    response?.raw,
  ];
  const value = candidates.find((candidate) =>
    ["string", "number", "bigint"].includes(typeof candidate),
  );
  if (value === undefined) throw new Error("WALLET_BALANCE_SHAPE_INVALID");
  return value;
}

const orderStatus = {
  pending: "Paying",
  processing: "Started",
  "on-hold": "Paying",
  completed: "Done",
  cancelled: "Cancelled",
  refunded: "Returned",
  failed: "Cancelled",
};

const contractStatus = {
  pending: "Not Ready",
  processing: "Confirmed",
  "on-hold": "Not Ready",
  completed: "Finished",
  cancelled: "Cancelled",
  refunded: "Cancelled",
  failed: "Failed",
};

function paymentGateway(value) {
  const key = String(value || "").toLowerCase();
  if (key.includes("wallet")) return "Wallet";
  if (key.includes("snapp")) return "SnappPay";
  if (key.includes("mellat") || key.includes("behpardakht")) return "Mellat";
  if (key.includes("saman") || key.includes("sep")) return "SamanKish";
  if (key.includes("zarin")) return "ZarinPal";
  return "Unknown";
}

function orderPayload(order) {
  const sourceId = String(order?.id || "");
  if (!/^\d+$/.test(sourceId) || sourceId === "0") throw new Error("ORDER_ID_INVALID");
  const date = new Date(order.date_created_gmt ? `${order.date_created_gmt}Z` : order.date_created);
  if (Number.isNaN(date.getTime())) throw new Error("ORDER_DATE_INVALID");
  const items = (Array.isArray(order.line_items) ? order.line_items : []).map((line) => {
    const count = Number(line.quantity);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("ORDER_ITEM_COUNT_INVALID");
    const variationSourceId = String(Number(line.variation_id) > 0 ? line.variation_id : line.product_id);
    if (!/^\d+$/.test(variationSourceId) || variationSourceId === "0") {
      throw new Error("ORDER_ITEM_PRODUCT_REFERENCE_INVALID");
    }
    let price = line.price;
    if (price === undefined || price === null || price === "") {
      price = (Number(line.total || 0) / count).toString();
    }
    return {
      sourceId: String(line.id),
      variationSourceId,
      count,
      unitPriceRial: decimalToInteger(price || 0, 10),
      title: cleanText(line.name, 255) || "WooCommerce product",
      sku: cleanText(line.sku, 255) || `WC-${variationSourceId}`,
    };
  });
  if (items.length === 0) throw new Error("ORDER_ITEMS_EMPTY");
  const shipping = Array.isArray(order.shipping_lines) ? order.shipping_lines[0] : null;
  const sourceTimestamps = wooSourceTimestamps(order);
  const gateway = paymentGateway(order.payment_method);
  const totalTaxRial = decimalToInteger(order.total_tax || 0, 10);
  if (totalTaxRial !== "0") throw new Error("ORDER_NONZERO_TAX_REQUIRES_MAPPING");
  return {
    sourceId,
    customerSourceId: Number(order.customer_id) > 0 ? String(order.customer_id) : null,
    guestPhone: Number(order.customer_id) > 0 ? null : canonicalPhone(order?.billing?.phone),
    date: date.toISOString(),
    status: orderStatus[order.status] || "Paying",
    contractStatus: contractStatus[order.status] || "Not Ready",
    totalRial: decimalToInteger(order.total || 0, 10),
    shippingRial: decimalToInteger(order.shipping_total || 0, 10),
    shippingMethodCode: cleanText(shipping?.method_id, 255) || null,
    shippingMethodTitle: cleanText(shipping?.method_title, 255) || null,
    paymentGateway: gateway,
    contractType: gateway === "SnappPay" ? "Credit" : "Cash",
    taxPercent: 0,
    ...(sourceTimestamps ? {
      sourceCreatedAt: sourceTimestamps.createdAt,
      sourceUpdatedAt: sourceTimestamps.updatedAt,
    } : {}),
    items,
  };
}

function seoValue(post, keys) {
  for (const key of keys) {
    const value = post?.meta?.[key] ?? post?.[key];
    if (Array.isArray(value) && value[0]) return String(value[0]);
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function blogPostPayload(post) {
  const title = cleanText(rendered(post.title), 255);
  const slug = cleanText(post.slug, 150);
  const content = rendered(post.content);
  if (!title || !slug || !content) throw new Error("BLOG_REQUIRED_FIELD_MISSING");
  const status = post.status === "publish" ? "Published" : post.status === "future" ? "Scheduled" : "Draft";
  const published = new Date(post.date_gmt ? `${post.date_gmt}Z` : post.date);
  return {
    sourceId: String(post.id),
    sourceTimestamps: wordpressSourceTimestamps(post),
    data: {
      Title: title,
      Slug: slug,
      Content: content,
      Excerpt: cleanText(rendered(post.excerpt).replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), 500),
      Status: status,
      PublishedAt: Number.isNaN(published.getTime()) ? null : published.toISOString(),
      MetaTitle: cleanText(seoValue(post, ["_yoast_wpseo_title", "rank_math_title"]), 60) || null,
      MetaDescription: cleanText(seoValue(post, ["_yoast_wpseo_metadesc", "rank_math_description"]), 160) || null,
      Keywords: cleanText(seoValue(post, ["rank_math_focus_keyword", "_yoast_wpseo_focuskw"]), 2000) || null,
    },
    categoryIds: Array.isArray(post.categories) ? post.categories.map(String) : [],
    tagIds: Array.isArray(post.tags) ? post.tags.map(String) : [],
    authorId: String(post.author || ""),
    featuredMediaId: Number(post.featured_media) > 0 ? String(post.featured_media) : null,
  };
}

module.exports = {
  canonicalPhone,
  decimalToInteger,
  customerPayload,
  walletPayload,
  walletBalanceValue,
  orderPayload,
  blogPostPayload,
};
