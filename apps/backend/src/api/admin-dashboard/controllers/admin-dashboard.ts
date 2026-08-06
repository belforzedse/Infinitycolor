import { sanitize } from "@strapi/utils";
import { ROLE_NAMES, resolveUserRoleName } from "../../../utils/roles";

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

export default {
  async query(ctx) {
    const startedAt = Date.now();
    const roleName = await resolveUserRoleName(strapi, ctx.state?.user);
    const includeCustomerAccounts = roleName === ROLE_NAMES.SUPERADMIN;
    const knex = strapi.db.connection;

    const countsSql = includeCustomerAccounts
      ? `SELECT
           (SELECT COUNT(*) FROM orders)::bigint AS orders_total,
           (SELECT COUNT(*) FROM orders WHERE status = 'Done')::bigint AS done_orders_total,
           (SELECT COUNT(*) FROM products WHERE status = 'Active' AND removed_at IS NULL)::bigint AS active_products_total,
           (SELECT COUNT(*) FROM users WHERE blocked = false AND removed_at IS NULL)::bigint AS customer_accounts_total`
      : `SELECT
           (SELECT COUNT(*) FROM orders)::bigint AS orders_total,
           (SELECT COUNT(*) FROM orders WHERE status = 'Done')::bigint AS done_orders_total,
           (SELECT COUNT(*) FROM products WHERE status = 'Active' AND removed_at IS NULL)::bigint AS active_products_total`;

    const [countsResult, latestRows] = await Promise.all([
      knex.raw(countsSql),
      strapi.query("api::order.order").findMany({
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
      }),
    ]);

    const schema = strapi.contentType("api::order.order");
    const sanitizedRows = await sanitize.contentAPI.output(latestRows, schema, {
      auth: ctx.state.auth,
    });
    const latestOrders = (sanitizedRows as any[]).map(projectLatestOrder);
    const counts = firstRow(countsResult);

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = {
      data: {
        metrics: {
          ordersTotal: Number(counts.orders_total) || 0,
          doneOrdersTotal: Number(counts.done_orders_total) || 0,
          activeProductsTotal: Number(counts.active_products_total) || 0,
          customerAccountsTotal: includeCustomerAccounts
            ? Number(counts.customer_accounts_total) || 0
            : null,
        },
        latestOrders,
        latestOrdersAmount: latestOrders.reduce(
          (sum, order) => sum + Number(order.attributes.contract.data?.attributes.Amount || 0),
          0,
        ),
      },
    };

    strapi.log.info("admin dashboard summary completed", {
      durationMs: Date.now() - startedAt,
      returnedLatestOrders: latestOrders.length,
      includeCustomerAccounts,
    });
  },
};
