import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { finalizeToOrderHandler } from "../controllers/handlers/finalizeToOrder";
import { createCtx, createStrapiMock } from "../../../__tests__/helpers/test-utils";

/**
 * Server-side guards on attaching a later order to a live reserve shipment.
 *
 * These are the security/correctness boundary: the storefront countdown is
 * display-only, so every rule here must hold even when the client insists.
 */

const ACTIVE_DEADLINE = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

function setup(groupRow: any, paidMemberCount = 1) {
  const { strapi, registerQuery } = createStrapiMock();
  strapi.entityService.findMany = jest
    .fn()
    .mockResolvedValue([{ Title: "SnappPay", IsActive: true }]) as any;

  const groupFindOne = jest.fn().mockResolvedValue(groupRow);
  registerQuery("api::reserve-group.reserve-group", { findOne: groupFindOne });
  registerQuery("api::order.order", {
    count: jest.fn().mockResolvedValue(paidMemberCount),
    findOne: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
  });

  return { strapi, groupFindOne };
}

const attachCtx = (groupKey: string, userId = 1) =>
  createCtx({
    request: { body: { reserveGroupId: groupKey, gateway: "snappay" } },
    state: { user: { id: userId, role: { type: "authenticated" } } },
  });

describe("attaching an order to a reserve shipment", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rejects an attach once the window has closed", async () => {
    // findAttachableGroup filters on State/expiresAt, so an expired window
    // resolves to nothing no matter what the browser still displays.
    const { strapi } = setup(null);
    const handler = finalizeToOrderHandler(strapi as any);

    await expect(handler(attachCtx("expired-group"))).rejects.toMatchObject({
      status: 400,
      payload: expect.objectContaining({
        data: expect.objectContaining({ errorCode: "RESERVE_NOT_FOUND" }),
      }),
    });
  });

  it("scopes the lookup to the authenticated owner", async () => {
    const { strapi, groupFindOne } = setup(null);
    const handler = finalizeToOrderHandler(strapi as any);

    await expect(handler(attachCtx("someone-elses-group", 7))).rejects.toMatchObject({
      status: 400,
    });

    // The owner predicate is what stops one customer attaching to another's
    // shipment; it must be part of the query, not a post-hoc check.
    expect(groupFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          owner: { id: 7 },
          groupKey: "someone-elses-group",
        }),
      }),
    );
  });

  it("refuses a group whose orders were never actually paid for", async () => {
    // Otherwise an abandoned first payment keeps collecting free-shipping
    // children onto a parcel that will never ship.
    const { strapi } = setup(
      {
        id: 5,
        groupKey: "unpaid-group",
        State: "Active",
        expiresAt: ACTIVE_DEADLINE,
        ShippingMethodCode: "post",
      },
      0,
    );
    const handler = finalizeToOrderHandler(strapi as any);

    await expect(handler(attachCtx("unpaid-group"))).rejects.toMatchObject({
      status: 400,
      payload: expect.objectContaining({
        data: expect.objectContaining({ errorCode: "RESERVE_NOT_FOUND" }),
      }),
    });
  });

  it("queries only Active groups with a future deadline", async () => {
    const { strapi, groupFindOne } = setup(null);
    const handler = finalizeToOrderHandler(strapi as any);

    await expect(handler(attachCtx("g-1"))).rejects.toMatchObject({ status: 400 });

    const where = (groupFindOne.mock.calls[0] as any[])[0].where;
    expect(where.State).toBe("Active");
    expect(where.expiresAt).toHaveProperty("$gt");
  });
});

describe("opening a new reserve shipment", () => {
  beforeEach(() => jest.clearAllMocks());

  it("refuses a second overlapping window for the same customer", async () => {
    // Checked before the gateway: activation happens inside the settlement
    // transaction, which must never fail for something catchable at checkout.
    const { strapi } = setup({
      id: 5,
      groupKey: "already-open",
      State: "Active",
      expiresAt: ACTIVE_DEADLINE,
    });
    const handler = finalizeToOrderHandler(strapi as any);

    const ctx = createCtx({
      request: { body: { reserveShipping: true, shipping: 1, gateway: "snappay" } },
      state: { user: { id: 1, role: { type: "authenticated" } } },
    });

    await expect(handler(ctx)).rejects.toMatchObject({
      status: 400,
      payload: expect.objectContaining({
        data: expect.objectContaining({ errorCode: "RESERVE_ALREADY_ACTIVE" }),
      }),
    });
  });

  it("lets an ordinary separate order through untouched", async () => {
    // Declining consolidation must stay possible during an active window.
    const { strapi, groupFindOne } = setup(null);
    const handler = finalizeToOrderHandler(strapi as any);

    const ctx = createCtx({
      request: { body: { gateway: "snappay", shipping: 1 } },
      state: { user: { id: 1, role: { type: "authenticated" } } },
    });

    await expect(handler(ctx)).rejects.toMatchObject({ status: 400 });
    // No reserve intent -> no group lookup at all.
    expect(groupFindOne).not.toHaveBeenCalled();
  });
});
