import { sanitize } from "@strapi/utils";
import { hasCapability } from "@repo/auth-core";
import { resolveAdminActor } from "../../../utils/adminAuthorization";
import { tehranDayBounds } from "../../../utils/businessTime";
import {
  activeReserveGroupsWhere,
  ORDER_STATUS_BUCKETS,
} from "../../admin-order-list/lib/order-buckets";
import { UID as RESERVE_GROUP_UID } from "../../reserve-group/lib/reserve-group";

function projectLatestOrder(order: any) {
  const userInfo = order.user?.user_info;
  const contract = order.contract;
  return {
    id: order.id,
    attributes: {
      Status: order.Status ?? null,
      Date: order.Date ?? null,
      createdAt: order.createdAt ?? null,
      updatedAt: order.updatedAt ?? null,
      user: {
        data: order.user
          ? {
              id: order.user.id,
              attributes: {
                user_info: {
                  data: userInfo
                    ? {
                        id: userInfo.id,
                        attributes: {
                          FirstName: userInfo.FirstName ?? null,
                          LastName: userInfo.LastName ?? null,
                        },
                      }
                    : null,
                },
              },
            }
          : null,
      },
      contract: {
        data: contract
          ? {
              id: contract.id,
              attributes: { Amount: Number(contract.Amount) || 0 },
            }
          : null,
      },
    },
  };
}

function firstRow(result: any): Record<string, unknown> {
  return (result?.rows || result?.[0] || [])[0] || {};
}

function placeholders(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

function orderCountsQuery(knex: any, now = new Date()) {
  const { start, end } = tehranDayBounds(now);
  const today = "o.date >= bounds.start_at AND o.date < bounds.end_at";
  return knex.raw(
    `WITH bounds AS (
       SELECT (?::timestamptz AT TIME ZONE 'UTC') AS start_at,
              (?::timestamptz AT TIME ZONE 'UTC') AS end_at
     )
     SELECT
       COUNT(*)::bigint AS orders_total,
       COUNT(*) FILTER (WHERE o.status IN (${placeholders(ORDER_STATUS_BUCKETS.completed)}))::bigint AS done_orders_total,
       COUNT(*) FILTER (WHERE ${today})::bigint AS today_orders_total,
       COUNT(*) FILTER (WHERE ${today} AND o.status IN (${placeholders(ORDER_STATUS_BUCKETS.paying)}))::bigint AS today_paying_total,
       COUNT(*) FILTER (WHERE ${today} AND o.status IN (${placeholders(ORDER_STATUS_BUCKETS.inprogress)}))::bigint AS today_inprogress_total,
       COUNT(*) FILTER (WHERE ${today} AND o.status IN (${placeholders(ORDER_STATUS_BUCKETS.completed)}))::bigint AS today_completed_total,
       COUNT(*) FILTER (WHERE ${today} AND o.status IN (${placeholders(ORDER_STATUS_BUCKETS.cancelled)}))::bigint AS today_cancelled_total
     FROM orders o
     CROSS JOIN bounds`,
    [
      start.toISOString(),
      end.toISOString(),
      ...ORDER_STATUS_BUCKETS.completed,
      ...ORDER_STATUS_BUCKETS.paying,
      ...ORDER_STATUS_BUCKETS.inprogress,
      ...ORDER_STATUS_BUCKETS.completed,
      ...ORDER_STATUS_BUCKETS.cancelled,
    ],
  );
}

export default {
  async query(ctx) {
    const startedAt = Date.now();
    const actor = await resolveAdminActor(strapi, ctx.state?.user);
    if (!actor) return ctx.forbidden("Administrative role required");
    const includeOrders = hasCapability(actor.role, "order.read");
    const includeProducts = hasCapability(actor.role, "product.read");
    const includeCustomerAccounts = hasCapability(actor.role, "system.users.manage");
    const knex = strapi.db.connection;

    const countExpressions = [
      ...(includeProducts
        ? [
            "(SELECT COUNT(*) FROM products WHERE status = 'Active' AND removed_at IS NULL)::bigint AS active_products_total",
          ]
        : []),
      ...(includeCustomerAccounts
        ? [
            "(SELECT COUNT(*) FROM users WHERE blocked = false AND removed_at IS NULL)::bigint AS customer_accounts_total",
          ]
        : []),
    ];

    const countsPromise = countExpressions.length
      ? knex.raw(`SELECT ${countExpressions.join(", ")}`)
      : Promise.resolve({ rows: [{}] });
    const orderCountsPromise = includeOrders
      ? orderCountsQuery(knex)
      : Promise.resolve({ rows: [{}] });
    const activeReserveGroupsPromise = includeOrders
      ? strapi
          .query(RESERVE_GROUP_UID)
          .count({ where: activeReserveGroupsWhere(new Date()) })
      : Promise.resolve(null);
    const latestOrdersPromise = includeOrders
      ? strapi.query("api::order.order").findMany({
          select: ["id", "Status", "Date", "createdAt", "updatedAt"],
          populate: {
            user: {
              select: ["id"],
              populate: {
                user_info: { select: ["id", "FirstName", "LastName"] },
              },
            },
            contract: { select: ["id", "Amount"] },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          limit: 3,
        })
      : Promise.resolve([]);

    const [countsResult, orderCountsResult, activeReserveGroups, latestRows] =
      await Promise.all([
        countsPromise,
        orderCountsPromise,
        activeReserveGroupsPromise,
        latestOrdersPromise,
      ]);

    const schema = strapi.contentType("api::order.order");
    // Roles with `order.read` intentionally do not need direct find grants on
    // contracts or customer profiles. Passing request auth to Strapi's generic
    // sanitizer therefore removes the two bounded relations selected above,
    // making the overview render unknown customers and zero amounts. The
    // explicit select/populate plus projectLatestOrder() remain the response
    // allowlist, matching the dedicated admin orders list.
    const sanitizedRows = await sanitize.contentAPI.output(latestRows, schema);
    const latestOrders = (sanitizedRows as any[]).map(projectLatestOrder);
    const counts = firstRow(countsResult);
    const orderCounts = firstRow(orderCountsResult);

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = {
      data: {
        metrics: {
          ordersTotal: includeOrders ? Number(orderCounts.orders_total) || 0 : null,
          doneOrdersTotal: includeOrders ? Number(orderCounts.done_orders_total) || 0 : null,
          activeProductsTotal: includeProducts ? Number(counts.active_products_total) || 0 : null,
          customerAccountsTotal: includeCustomerAccounts
            ? Number(counts.customer_accounts_total) || 0
            : null,
        },
        todayOrderCounts: includeOrders
          ? {
              all: Number(orderCounts.today_orders_total) || 0,
              paying: Number(orderCounts.today_paying_total) || 0,
              inprogress: Number(orderCounts.today_inprogress_total) || 0,
              completed: Number(orderCounts.today_completed_total) || 0,
              cancelled: Number(orderCounts.today_cancelled_total) || 0,
            }
          : null,
        activeReserveGroups: includeOrders ? Number(activeReserveGroups) || 0 : null,
        latestOrders,
        latestOrdersAmount: latestOrders.reduce(
          (sum, order) => sum + Number(order.attributes.contract.data?.attributes.Amount || 0),
          0,
        ),
        authorizedModules: {
          orders: includeOrders,
          products: includeProducts,
          users: includeCustomerAccounts,
          content: hasCapability(actor.role, "content.blog.read"),
          productReports: hasCapability(actor.role, "report.product.read"),
          finance: hasCapability(actor.role, "report.finance.read"),
          traffic: hasCapability(actor.role, "report.traffic.read"),
          wallets: hasCapability(actor.role, "wallet.read"),
        },
      },
    };

    strapi.log.info("admin dashboard summary completed", {
      durationMs: Date.now() - startedAt,
      returnedLatestOrders: latestOrders.length,
      includeCustomerAccounts,
      role: actor.role,
    });
  },
};
