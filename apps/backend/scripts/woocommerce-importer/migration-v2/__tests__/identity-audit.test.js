"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runIdentityAudit } = require("../identity-audit");

function response(data) {
  return {
    data,
    headers: { get: (name) => name === "x-wp-totalpages" ? "1" : null },
  };
}

test("identity audit emits aggregate collision and name coverage without PII", async () => {
  const customers = [
    { id: 1, email: "one@example.com", billing: { phone: "09120000001" } },
    { id: 2, email: "two@example.com", billing: { phone: "09120000001" } },
    { id: 3, email: "shared@example.com", billing: { phone: "09120000003" } },
    { id: 4, email: "shared@example.com", billing: { phone: "09120000004" } },
  ];
  const orders = [
    { id: 10, customer_id: 0, billing: { phone: "09120000001", email: "a@example.com", first_name: "A", last_name: "One" } },
    { id: 11, customer_id: 0, billing: { phone: "09120000001", email: "b@example.com", first_name: "B", last_name: "Two" } },
    { id: 12, customer_id: 0, billing: { phone: "bad", email: "email-only@example.com", first_name: "C", last_name: "Three" } },
    { id: 13, customer_id: 8, billing: { phone: "09120000008", first_name: "D", last_name: "Four" } },
  ];
  const source = {
    woo: {
      get: async (pathname) => response(pathname === "/customers" ? customers : orders),
    },
    metrics: () => ({ woo: { requests: 2 } }),
  };

  const report = await runIdentityAudit({ source });
  assert.equal(report.customers.total, 4);
  assert.equal(report.orders.withBothNames, 4);
  assert.equal(report.collisions.customerDuplicatePhoneGroups, 1);
  assert.equal(report.collisions.customerEmailsUsedByMultiplePhones, 1);
  assert.equal(report.collisions.guestPhoneGroupsWithMultipleEmails, 1);
  assert.equal(report.resolution.ambiguousGuestPhoneGroups, 1);
  assert.equal(report.resolution.unclaimableGuestOrders, 1);
  assert.ok(!JSON.stringify(report).includes("example.com"));
  assert.ok(!JSON.stringify(report).includes("0912"));
});
