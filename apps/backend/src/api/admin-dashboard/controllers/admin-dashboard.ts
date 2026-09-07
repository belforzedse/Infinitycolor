import { sanitize } from "@strapi/utils";
import { hasCapability } from "@repo/auth-core";
import { resolveAdminActor } from "../../../utils/adminAuthorization";

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
    const actor = await resolveAdminActor(strapi, ctx.state?.user);
    if (!actor) return ctx.forbidden("Administrative role required");
    const includeOrders = hasCapability(actor.role, "order.read");
    const includeProducts = hasCapability(actor.role, "product.read");
    const includeCustomerAccounts = hasCapability(actor.role, "system.users.manage");
    const knex = strapi.db.connection;

    const countExpressions = [
      ...(includeOrders
        ? [
            "(SELECT COUNT(*) FROM orders)::bigint AS orders_total",
            "(SELECT COUNT(*) FROM orders WHERE status = 'Done')::bigint AS done_orders_total",
          ]
        : []),
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

    const [countsResult, latestRows] = await Promise.all([
      countsPromise,
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

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = {
      data: {
        metrics: {
          ordersTotal: includeOrders ? Number(counts.orders_total) || 0 : null,
          doneOrdersTotal: includeOrders ? Number(counts.done_orders_total) || 0 : null,
          activeProductsTotal: includeProducts ? Number(counts.active_products_total) || 0 : null,
          customerAccountsTotal: includeCustomerAccounts
            ? Number(counts.customer_accounts_total) || 0
            : null,
        },
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
