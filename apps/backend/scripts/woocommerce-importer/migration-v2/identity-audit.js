"use strict";

const { configureSourceEnvironment } = require("./lib/env");
const { WordPressSource } = require("./lib/source");
const { canonicalPhone } = require("./lib/transforms");

function normalizedEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function addToSetMap(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

async function mapPool(items, concurrency, action) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await action(items[index]);
    }
  }));
}

async function scanWooPages(source, pathname, visit, concurrency = 4) {
  const request = (page) => source.woo.get(pathname, {
    per_page: 100,
    page,
    orderby: "id",
    order: "asc",
  });
  const first = await request(1);
  const totalPages = Math.max(1, Number(first.headers.get("x-wp-totalpages")) || 1);
  const consume = (response) => {
    for (const row of Array.isArray(response.data) ? response.data : []) visit(row);
  };
  consume(first);
  await mapPool(
    Array.from({ length: totalPages - 1 }, (_, index) => index + 2),
    concurrency,
    async (page) => consume(await request(page)),
  );
}

async function runIdentityAudit({ source = new WordPressSource(configureSourceEnvironment()) } = {}) {
  const startedAt = Date.now();
  const customerPhones = new Map();
  const customerEmails = new Map();
  const customerEmailPhones = new Map();
  const guestPhones = new Map();
  const stats = {
    customers: { total: 0, validPhone: 0, invalidOrMissingPhone: 0, validEmail: 0 },
    orders: {
      total: 0,
      registered: 0,
      guest: 0,
      withFirstName: 0,
      withLastName: 0,
      withBothNames: 0,
      missingBothNames: 0,
      guestValidPhone: 0,
      guestInvalidOrMissingPhone: 0,
      guestValidEmail: 0,
    },
  };

  await scanWooPages(source, "/customers", (customer) => {
    stats.customers.total += 1;
    const sourceId = String(customer.id);
    const phone = canonicalPhone(customer?.billing?.phone || customer?.shipping?.phone);
    const email = normalizedEmail(customer.email);
    if (phone) {
      stats.customers.validPhone += 1;
      addToSetMap(customerPhones, phone, sourceId);
    } else stats.customers.invalidOrMissingPhone += 1;
    if (email) {
      stats.customers.validEmail += 1;
      addToSetMap(customerEmails, email, sourceId);
      if (phone) addToSetMap(customerEmailPhones, email, phone);
    }
  });

  await scanWooPages(source, "/orders", (order) => {
    stats.orders.total += 1;
    const registered = Number(order.customer_id) > 0;
    if (registered) stats.orders.registered += 1;
    else stats.orders.guest += 1;
    const firstName = String(order?.billing?.first_name || "").trim();
    const lastName = String(order?.billing?.last_name || "").trim();
    if (firstName) stats.orders.withFirstName += 1;
    if (lastName) stats.orders.withLastName += 1;
    if (firstName && lastName) stats.orders.withBothNames += 1;
    if (!firstName && !lastName) stats.orders.missingBothNames += 1;
    if (registered) return;

    const phone = canonicalPhone(order?.billing?.phone);
    const email = normalizedEmail(order?.billing?.email);
    if (!phone) {
      stats.orders.guestInvalidOrMissingPhone += 1;
      if (email) stats.orders.guestValidEmail += 1;
      return;
    }
    stats.orders.guestValidPhone += 1;
    if (email) stats.orders.guestValidEmail += 1;
    if (!guestPhones.has(phone)) {
      guestPhones.set(phone, { orders: 0, emails: new Set(), names: new Set() });
    }
    const group = guestPhones.get(phone);
    group.orders += 1;
    if (email) group.emails.add(email);
    if (firstName || lastName) group.names.add(`${firstName}\u0000${lastName}`);
  });

  const customerPhoneGroups = Array.from(customerPhones.values());
  const customerEmailGroups = Array.from(customerEmails.values());
  const guestGroups = Array.from(guestPhones.entries());
  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    ...stats,
    collisions: {
      customerDuplicatePhoneGroups: customerPhoneGroups.filter((owners) => owners.size > 1).length,
      customersInDuplicatePhoneGroups: customerPhoneGroups
        .filter((owners) => owners.size > 1)
        .reduce((total, owners) => total + owners.size, 0),
      customerDuplicateEmailGroups: customerEmailGroups.filter((owners) => owners.size > 1).length,
      customerEmailsUsedByMultiplePhones: Array.from(customerEmailPhones.values())
        .filter((phones) => phones.size > 1).length,
      guestPhoneGroupsWithMultipleEmails: guestGroups.filter(([, group]) => group.emails.size > 1).length,
      guestPhoneGroupsWithMultipleNames: guestGroups.filter(([, group]) => group.names.size > 1).length,
      guestPhoneGroupsMatchingMultipleWooCustomers: guestGroups
        .filter(([phone]) => Number(customerPhones.get(phone)?.size || 0) > 1).length,
    },
    resolution: {
      uniqueGuestPhoneGroups: guestGroups.length,
      repeatGuestPhoneGroups: guestGroups.filter(([, group]) => group.orders > 1).length,
      guestPhoneGroupsMatchingOneWooCustomer: guestGroups
        .filter(([phone]) => Number(customerPhones.get(phone)?.size || 0) === 1).length,
      guestPhoneGroupsMatchingNoWooCustomer: guestGroups
        .filter(([phone]) => !customerPhones.has(phone)).length,
      safelyClaimableGuestPhoneGroups: guestGroups
        .filter(([phone]) => Number(customerPhones.get(phone)?.size || 0) <= 1).length,
      ambiguousGuestPhoneGroups: guestGroups
        .filter(([phone]) => Number(customerPhones.get(phone)?.size || 0) > 1).length,
      unclaimableGuestOrders: stats.orders.guestInvalidOrMissingPhone,
    },
    sourceMetrics: source.metrics(),
  };
}

if (require.main === module) {
  runIdentityAudit()
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify({ error: error?.code || error?.name || "IDENTITY_AUDIT_FAILED" }));
      process.exit(1);
    });
}

module.exports = { runIdentityAudit, normalizedEmail };
