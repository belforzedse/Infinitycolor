"use strict";

const {
  classifyOrderLine,
  orphanLineSku,
  ORDER_LINE_ORPHAN,
  ORDER_LINE_CATALOG,
} = require("./orderLines");

const {
  wooSourceTimestamps,
  wordpressSourceTimestamps,
} = require("../../utils/sourceTimestamps");

function toEnglishDigits(value) {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

/**
 * Canonicalise any Iranian mobile input to E.164 (`+989XXXXXXXXX`).
 *
 * Strips every non-digit *before* prefix matching. The previous version kept
 * `+` (`[^\d+]`), so a leading `+` matched none of the digit-prefix branches and
 * real numbers such as "+09123381098" or "+98 0912 338 1098" fell through to
 * null — dropping the customer, their wallet and their orders.
 *
 * Deliberately shape-based (`9` + 9 digits) rather than an operator-prefix
 * allowlist: an allowlist silently rejects newly assigned prefixes, which was
 * measured against production as a net regression.
 */
function canonicalPhone(value) {
  let digits = toEnglishDigits(value).replace(/\D/g, "");
  if (digits.startsWith("0098")) digits = digits.slice(4);
  else if (digits.startsWith("98") && digits.length >= 12) digits = digits.slice(2);
  // Not `else if`: an international prefix can still be followed by a trunk 0.
  if (digits.startsWith("0")) digits = digits.slice(1);
  return /^9\d{9}$/.test(digits) ? `+98${digits}` : null;
}

function decimalToInteger(value, multiplier) {
  if (!Number.isSafeInteger(multiplier) || multiplier < 1) {
    throw new Error("MONEY_MULTIPLIER_INVALID");
  }
  const raw = toEnglishDigits(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error("MONEY_FORMAT_INVALID");
  const [whole, fraction = ""] = raw.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`) * BigInt(multiplier);
  if (numerator % scale !== 0n) throw new Error("MONEY_NOT_EXACT_AFTER_CONVERSION");
  return (numerator / scale).toString();
}

function wooMoneyToToman(value) {
  return decimalToInteger(value, 1);
}

function wooMoneyToRial(value) {
  return decimalToInteger(value, 10);
}

/**
 * Fee lines are the only WooCommerce money that is legitimately negative (the
 * wallet leg of a split payment, the SnappPay payment-method discount). Order
 * totals and line prices stay on the strict parser above.
 */
function signedWooMoneyToToman(value) {
  const raw = toEnglishDigits(value).trim();
  const negative = raw.startsWith("-");
  const magnitude = BigInt(wooMoneyToToman(negative ? raw.slice(1) : raw));
  return (negative ? -magnitude : magnitude).toString();
}

/**
 * TeraWallet often returns IEEE floats (e.g. 690818999.9999999). Wallet balances
 * are stored as integer Rial = round(toman) * 10. Order line money must stay exact —
 * do not use this for order totals/prices.
 */
function wooWalletBalanceToRial(value) {
  const raw = toEnglishDigits(value).trim();
  if (!raw) throw new Error("MONEY_FORMAT_INVALID");
  const asNumber = Number(raw);
  if (!Number.isFinite(asNumber) || asNumber < 0) throw new Error("MONEY_FORMAT_INVALID");
  const toman = Math.round(asNumber);
  if (!Number.isSafeInteger(toman)) throw new Error("MONEY_FORMAT_INVALID");
  return (BigInt(toman) * 10n).toString();
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function wooPostalCode(value) {
  const digits = toEnglishDigits(value).replace(/\D/g, "");
  return /^\d{10}$/.test(digits) && digits !== "0000000000" ? digits : null;
}

function orderDeliveryAddress(order) {
  const shipping = order?.shipping || {};
  const billing = order?.billing || {};
  const stateCode = cleanText(shipping.state || billing.state, 32).toUpperCase();
  const cityTitle = cleanText(shipping.city || billing.city, 255);
  const addressLine1 = cleanText(shipping.address_1 || billing.address_1, 2000);
  const addressLine2 = cleanText(shipping.address_2 || billing.address_2, 2000);
  const fullAddress = [addressLine1, addressLine2].filter(Boolean).join(" — ").slice(0, 4000);
  const firstName = cleanText(shipping.first_name || billing.first_name, 255);
  const lastName = cleanText(shipping.last_name || billing.last_name, 255);
  const recipientName = [firstName, lastName].filter(Boolean).join(" ").slice(0, 255);
  const recipientPhone = canonicalPhone(shipping.phone || billing.phone);
  const postalCode = wooPostalCode(shipping.postcode || billing.postcode);

  if (!stateCode && !cityTitle && !fullAddress) return null;
  return {
    stateCode,
    cityTitle,
    fullAddress,
    postalCode,
    recipientName,
    recipientPhone,
  };
}

function rendered(value) {
  return typeof value === "object" && value !== null ? String(value.rendered || "") : String(value || "");
}

function customerPayload(customer) {
  // Woo login usernames were phone numbers for most legacy TeraWallet accounts,
  // and billing/shipping phone is often empty or malformed (e.g. "+09120254536")
  // even though the account is real. Take the first field that yields a *valid*
  // number — testing emptiness instead would let a malformed billing entry mask
  // a good username and drop the customer along with their wallet.
  //
  // Login-first: the username is the number the customer actually authenticates
  // with, whereas billing phone is checkout form data that is routinely shared
  // across accounts (a spouse, an office line, a courier). Since a phone can
  // only belong to one account, the loser of a collision fails with
  // USER_PHONE_SOURCE_CONFLICT — and billing numbers collide roughly twice as
  // often as login numbers (1,876 duplicate groups vs 1,120; 67 groups with
  // orders/balance on both sides vs 38) at identical coverage. The billing
  // number is not lost: orders carry it independently as recipientPhone and
  // billingIdentity.phone.
  const phone = canonicalPhone(customer?.username)
    || canonicalPhone(customer?.billing?.phone)
    || canonicalPhone(customer?.shipping?.phone);
  if (!phone) {
    // Terminal by decision, not by failure: the phone is the login identity and
    // a WooCommerce account without one (most 2024 bulk registrations) cannot
    // become a user. `outcome: "excluded"` lets the sync record it once instead
    // of retrying it eight times per campaign; a later WooCommerce edit changes
    // the revision and the account is re-evaluated.
    throw Object.assign(new Error("USER_PHONE_INVALID"), {
      code: "USER_PHONE_INVALID",
      outcome: "excluded",
    });
  }
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
    balanceRial: wooWalletBalanceToRial(walletUser.balance ?? 0),
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

const ONLINE_GATEWAYS = new Set(["Mellat", "SamanKish", "SnappPay", "ZarinPal"]);

/**
 * Map a WooCommerce payment method to the order's gateway enum.
 *
 * Empty methods used to collapse to «نامشخص» with the meaning hidden: they are
 * orders an operator created in the WooCommerce admin (`created_via: "admin"`),
 * so those become `Manual`. Card-to-card (`shetab`, `bacs`) and any other
 * offline method get their own labels instead of the catch-all.
 */
function paymentGateway(value, title = "", context = {}) {
  const method = String(value || "").trim().toLowerCase();
  const key = `${method} ${title || ""}`.toLowerCase().trim();
  if (!key) return context.createdVia === "admin" ? "Manual" : "Unknown";
  if (key.includes("wallet") || key.includes("کیف پول")) return "Wallet";
  if (key.includes("snapp") || key.includes("اسنپ")) return "SnappPay";
  if (key.includes("mellat") || key.includes("behpardakht") || key.includes("ملت")) return "Mellat";
  if (key.includes("saman") || key.includes("sep") || key.includes("سامان")) return "SamanKish";
  if (key.includes("zarin") || key.includes("زرین")) return "ZarinPal";
  if (key.includes("shetab") || key.includes("bacs") || key.includes("کارت به کارت")) return "CardToCard";
  return "Other";
}

const WALLET_FEE = /کیف\s*پول|wallet/i;
const SNAPPPAY_FEE = /اسنپ|snapp/i;

/**
 * Classify WooCommerce `fee_lines`.
 *
 * WooCommerce's `total` is only what the gateway charged. Two plugins express
 * the rest as negative fee lines: TeraWallet's partial payment («با کیف پول» /
 * «از طریق کیف پول») is the wallet leg of a split payment, and the SnappPay
 * plugin's «تخفیف پرداخت با اسنپ‌پی» is a payment-method discount the customer
 * really did not pay. Any other negative fee is treated as a discount; a
 * positive fee is a surcharge the customer paid.
 *
 * Coupon discounts (`discount_total`) are deliberately NOT returned here: line
 * prices are taken from `line_items[].total`, which WooCommerce already reports
 * net of coupons, so counting them again would subtract them twice.
 */
function classifyFeeLines(order) {
  const totals = { walletLeg: 0n, paymentMethodDiscount: 0n, otherDiscount: 0n, surcharge: 0n };
  for (const fee of Array.isArray(order?.fee_lines) ? order.fee_lines : []) {
    const amount = BigInt(signedWooMoneyToToman(fee?.total ?? 0));
    if (amount === 0n) continue;
    const name = String(fee?.name || "");
    if (amount > 0n) totals.surcharge += amount;
    else if (WALLET_FEE.test(name)) totals.walletLeg += -amount;
    else if (SNAPPPAY_FEE.test(name)) totals.paymentMethodDiscount += -amount;
    else totals.otherDiscount += -amount;
  }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value.toString()]));
}

const PAID_WOO_STATUSES = new Set(["processing", "completed", "refunded"]);

/**
 * One settlement leg per payment that actually moved money, so the reports can
 * show cash per channel (a split order sits under both Wallet and its gateway)
 * and key money pages on the payment date rather than the order date.
 *
 * - `gateway` leg: WooCommerce `total` — the amount the gateway (or the wallet,
 *   on a wallet-only order) charged. A Payzito-plugin method (`pa_*`) with no
 *   `transaction_id` on a paid order was settled outside the gateway (the
 *   Gorgan branch takes card payments and completes the order by hand), so the
 *   leg is tagged `OffGateway` rather than credited to the gateway. Only the
 *   Payzito plugin writes `transaction_id` at all: the earlier SnappPay plugin
 *   (`WC_Gateway_SnappPay`, until 2026-05-20) never did, so its orders carry no
 *   reference and are credited to SnappPay as they were paid.
 * - `wallet` leg: the negative wallet fee line.
 * - `return` leg: on a refunded order, the refund total (falling back to the
 *   full sales value; the store has never issued a partial refund).
 *
 * Only processing / completed / refunded orders have legs: WooCommerce keeps
 * `date_paid` on an order that was paid and then cancelled, and that money is
 * not revenue.
 */
function settlementLegs(order, { gateway, totalToman, walletLegToman, salesValueToman, paidAt, hasGatewayReference }) {
  if (!PAID_WOO_STATUSES.has(String(order?.status || ""))) return [];
  const legs = [];
  if (BigInt(totalToman) > 0n) {
    let channel = gateway;
    const payzitoMethod = /^pa_/i.test(String(order?.payment_method || "").trim());
    if (ONLINE_GATEWAYS.has(gateway) && payzitoMethod && !hasGatewayReference) channel = "OffGateway";
    legs.push({ leg: "gateway", channel, amountToman: totalToman, date: paidAt });
  }
  if (BigInt(walletLegToman) > 0n) {
    legs.push({ leg: "wallet", channel: "Wallet", amountToman: walletLegToman, date: paidAt });
  }
  if (order.status === "refunded") {
    let refunded = 0n;
    for (const refund of Array.isArray(order.refunds) ? order.refunds : []) {
      try {
        const amount = BigInt(signedWooMoneyToToman(refund?.total ?? 0));
        refunded += amount < 0n ? -amount : amount;
      } catch {
        // A malformed refund total falls back to the whole sales value below.
      }
    }
    const amountToman = (refunded > 0n ? refunded : BigInt(salesValueToman)).toString();
    if (BigInt(amountToman) > 0n) {
      legs.push({ leg: "return", channel: gateway, amountToman, date: paidAt });
    }
  }
  return legs;
}

/**
 * Prefer exact line.total / quantity when both are integers so a noisy float
 * `price` cannot fail the whole order. Never round half-toman totals.
 */
function lineUnitPriceToman(line, count) {
  const totalRaw = line?.total;
  if (totalRaw !== undefined && totalRaw !== null && totalRaw !== "") {
    try {
      const totalToman = wooMoneyToToman(totalRaw);
      if (BigInt(totalToman) % BigInt(count) === 0n) {
        return (BigInt(totalToman) / BigInt(count)).toString();
      }
    } catch {
      // Fall through to price — malformed total is surfaced there or as ORDER totals.
    }
  }
  let price = line?.price;
  if (price === undefined || price === null || price === "") {
    throw new Error("ORDER_ITEM_PRICE_INVALID");
  }
  return wooMoneyToToman(price);
}

function orderPayload(order) {
  const sourceId = String(order?.id || "");
  if (!/^\d+$/.test(sourceId) || sourceId === "0") throw new Error("ORDER_ID_INVALID");
  const date = new Date(order.date_created_gmt ? `${order.date_created_gmt}Z` : order.date_created);
  if (Number.isNaN(date.getTime())) throw new Error("ORDER_DATE_INVALID");
  let orphanLineCount = 0;
  const items = (Array.isArray(order.line_items) ? order.line_items : []).map((line) => {
    const lineId = String(line?.id ?? "");
    if (!/^\d+$/.test(lineId) || lineId === "0") throw new Error("ORDER_ITEM_SOURCE_ID_INVALID");
    const count = Number(line.quantity);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("ORDER_ITEM_COUNT_INVALID");
    const reference = classifyOrderLine(line);
    const unitPriceToman = lineUnitPriceToman(line, count);
    const title = cleanText(line.name, 255) || "WooCommerce product";
    if (reference.kind === ORDER_LINE_ORPHAN) {
      // Historical sale whose product no longer exists in WooCommerce: keep the
      // snapshot, never guess a catalog item. The destination stores it with a
      // null catalog relation and a soft diagnostic.
      orphanLineCount += 1;
      return {
        sourceId: lineId,
        catalogReference: ORDER_LINE_ORPHAN,
        variationSourceId: null,
        count,
        unitPriceToman,
        title,
        sku: cleanText(line.sku, 255) || orphanLineSku(lineId),
      };
    }
    const { variationSourceId } = reference;
    return {
      sourceId: lineId,
      catalogReference: ORDER_LINE_CATALOG,
      variationSourceId,
      count,
      unitPriceToman,
      title,
      sku: cleanText(line.sku, 255) || `WC-${variationSourceId}`,
    };
  });
  if (items.length === 0) {
    // A zero-line order with a zero total is an artifact (an emptied admin
    // order), not a sale: exclude it terminally instead of retrying forever or
    // fabricating an order. A zero-line order that still carries money is
    // suspicious and fails closed under its own code.
    if (wooMoneyToToman(order.total || 0) === "0") {
      const excluded = new Error("ORDER_EMPTY_ZERO_TOTAL_EXCLUDED");
      excluded.code = "ORDER_EMPTY_ZERO_TOTAL_EXCLUDED";
      excluded.outcome = "excluded";
      throw excluded;
    }
    throw new Error("ORDER_ITEMS_EMPTY_NONZERO_TOTAL");
  }
  const shipping = Array.isArray(order.shipping_lines) ? order.shipping_lines[0] : null;
  const sourceTimestamps = wooSourceTimestamps(order);
  const createdVia = cleanText(order.created_via, 64) || null;
  const gateway = paymentGateway(order.payment_method, order.payment_method_title, { createdVia });
  const totalTaxToman = wooMoneyToToman(order.total_tax || 0);
  const totalToman = wooMoneyToToman(order.total || 0);
  const fees = classifyFeeLines(order);
  // Full sales value: what the customer owed across every leg. WooCommerce's
  // `total` is the gateway leg only (order 1222924: lines 12,694,000 + shipping
  // 115,000 − wallet fee 11,996,000 = total 813,000).
  const salesValueToman = (BigInt(totalToman) + BigInt(fees.walletLeg)).toString();
  const appliedDiscountToman = (BigInt(fees.paymentMethodDiscount) + BigInt(fees.otherDiscount)).toString();
  const paidDate = order.date_paid_gmt
    ? new Date(`${order.date_paid_gmt}Z`)
    : order.date_paid ? new Date(order.date_paid) : null;
  const paidAt = paidDate && !Number.isNaN(paidDate.getTime()) ? paidDate.toISOString() : date.toISOString();
  // The gateway reference itself must not leave WooCommerce; only whether one exists.
  const hasGatewayReference = Boolean(cleanText(order.transaction_id, 255));
  const registeredCustomer = Number(order.customer_id) > 0;
  const billingIdentity = {
    phone: canonicalPhone(order?.billing?.phone),
    email: cleanText(order?.billing?.email, 255) || null,
    firstName: cleanText(order?.billing?.first_name, 255),
    lastName: cleanText(order?.billing?.last_name, 255),
  };
  const guestPhone = registeredCustomer ? null : billingIdentity.phone;
  if (totalTaxToman !== "0") throw new Error("ORDER_NONZERO_TAX_REQUIRES_MAPPING");
  return {
    sourceId,
    customerSourceId: registeredCustomer ? String(order.customer_id) : null,
    guestPhone,
    orderIdentity: billingIdentity,
    guestIdentity: registeredCustomer ? null : billingIdentity,
    deliveryAddress: orderDeliveryAddress(order),
    date: date.toISOString(),
    status: orderStatus[order.status] || "Paying",
    contractStatus: contractStatus[order.status] || "Not Ready",
    totalToman,
    salesValueToman,
    appliedDiscountToman,
    paidAt,
    createdVia,
    hasGatewayReference,
    settlements: settlementLegs(order, {
      gateway,
      totalToman,
      walletLegToman: fees.walletLeg,
      salesValueToman,
      paidAt,
      hasGatewayReference,
    }),
    shippingToman: wooMoneyToToman(order.shipping_total || 0),
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
    orphanLineCount,
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

/**
 * @param {object} post The post as `context=edit` returns it.
 * @param {object} [options]
 * @param {string} [options.content] Body already transformed by
 *   `lib/blogContent.js` (carousels and promotional sections turned into the
 *   storefront's markers). Omitted, the rendered body is stored as-is, which is
 *   what every caller did before embedded blocks were understood.
 */
function blogPostPayload(post, options = {}) {
  const title = cleanText(rendered(post.title), 255);
  const slug = cleanText(post.slug, 150);
  const content = typeof options.content === "string" && options.content.trim()
    ? options.content
    : rendered(post.content);
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
  wooMoneyToToman,
  wooMoneyToRial,
  signedWooMoneyToToman,
  classifyFeeLines,
  paymentGateway,
  wooWalletBalanceToRial,
  lineUnitPriceToman,
  customerPayload,
  walletPayload,
  walletBalanceValue,
  wooPostalCode,
  orderDeliveryAddress,
  orderPayload,
  blogPostPayload,
};
