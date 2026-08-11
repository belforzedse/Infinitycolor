// @ts-nocheck
/**
 * order controller (slim delegator)
 */

import { factories } from "@strapi/strapi";
import { Strapi } from "@strapi/strapi";
import { generateAnipoBarcodeHandler } from "./helpers/generateBarcode";
import { verifyPaymentHandler } from "./helpers/payment";
import { snappayCallbackHandler } from "./helpers/snappayCallback";
import { adminAdjustItemsHandler } from "./helpers/adminAdjustItems";
import { adminCancelOrderHandler } from "./helpers/adminCancel";
import { adminPaymentOperationHandler } from "./helpers/adminPaymentOperation";
import { adminVoidBarcodeHandler } from "./helpers/adminVoidBarcode";
import { decrementManualOrderStockHandler } from "./helpers/manualOrderStock";
import { getActiveReserveHandler } from "./handlers/getActiveReserve";
import { releaseReserveHandler } from "./handlers/releaseReserve";
import { logAdminOrderCreate, logAdminOrderFieldUpdate } from "../../../utils/adminActivity";
import { getClientIp, getUserAgent } from "../../../utils/getClientIp";
import { adminTransitionOrderHandler } from "./helpers/adminTransition";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import { hasCapability, normalizeAdminRole } from "@repo/auth-core";
import { requireCapability, resolveAdminActor } from "../../../utils/adminAuthorization";
import {
  findOrderPaymentAttempt,
  reconcileOrderPaymentAttempt,
} from "../../payment-attempt/services/payment-attempt";
import { isSnappayGatewayValue } from "../../payment-gateway/services/checkout-gateway-availability";
import { isOperationalManagerRequest } from "../../../utils/operationalCommerce";

// Business fields captured as admin activity on a generic `PUT /orders/:id` edit. Whitelisted on
// purpose: anything not listed here (tokens, payment internals, relations) is never diffed/logged.
const AUDITED_ORDER_FIELDS = ["Status", "Note", "Description", "ShippingCost"] as const;

const ORDER_DETAIL_DEFAULT_PAGE = 1;
const ORDER_DETAIL_DEFAULT_PAGE_SIZE = 50;
const ORDER_DETAIL_MAX_PAGE_SIZE = 100;

const readQueryValue = (value: unknown): string | undefined => {
  if (Array.isArray(value)) return readQueryValue(value[0]);
  if (value === undefined || value === null) return undefined;
  return String(value);
};

const parsePositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(readQueryValue(value) || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const hasQueryParam = (query: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(query, key);

const parseDetailPagination = (
  query: Record<string, unknown>,
  pageKey: string,
  pageSizeKey: string,
) => {
  const enabled = hasQueryParam(query, pageKey) || hasQueryParam(query, pageSizeKey);
  if (!enabled) return null;

  const page = parsePositiveInt(query[pageKey], ORDER_DETAIL_DEFAULT_PAGE);
  const requestedPageSize = parsePositiveInt(query[pageSizeKey], ORDER_DETAIL_DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(requestedPageSize, ORDER_DETAIL_MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  return { page, pageSize, offset };
};

const buildPaginationMeta = (page: number, pageSize: number, total: number) => ({
  page,
  pageSize,
  pageCount: Math.ceil(total / pageSize),
  total,
});

export default factories.createCoreController(
  "api::order.order",
  ({ strapi }: { strapi: Strapi }) => ({
    async find(ctx, next) {
      if (await isOperationalManagerRequest(ctx, strapi)) {
        ctx.query = {
          ...ctx.query,
          fields: [
            "Description",
            "Note",
            "Status",
            "ReservationStatus",
            "ReservedUntil",
            "Date",
            "Type",
            "ShippingCost",
            "ShippingMethodCode",
            "ShippingMethodTitle",
            "ShippingBarcode",
            "ShippingPostPrice",
            "ShippingTax",
            "ShippingWeight",
            "ShippingBoxSizeId",
            "DiscountCode",
            "AppliedGeneralDiscountId",
            "AppliedDiscountAmount",
            "PaymentGateway",
            "isReserveOrder",
            "reserveExpiresAt",
            "createdAt",
            "updatedAt",
          ],
          populate: {
            user: {
              fields: ["id", "phone", "username"],
              populate: {
                user_info: { fields: ["FirstName", "LastName"] },
              },
            },
            contract: { fields: ["Amount", "Status"] },
          },
        };
      }
      return super.find(ctx, next);
    },

    async findOne(ctx) {
      const { id } = ctx.params;
      const requester = ctx.state.user;

      const requesterId = requester?.id ? Number(requester.id) : null;
      const actor = await resolveAdminActor(strapi, requester);
      const requesterRole =
        actor?.role ||
        normalizeAdminRole(requester?.role?.type) ||
        normalizeAdminRole(requester?.role?.name);
      const operationalManager = await isOperationalManagerRequest(ctx, strapi);
      const isAdminUser = requesterRole ? hasCapability(requesterRole, "order.read") : false;
      const canReadFinancials = requesterRole
        ? hasCapability(requesterRole, "order.financial.read")
        : false;

      try {
        // Query with all necessary relations populated
        const order = await strapi.db.query("api::order.order").findOne({
          where: { id },
          populate: {
            user: {
              fields: operationalManager ? ["id", "phone"] : ["id", "email", "phone", "username"],
              populate: {
                user_info: operationalManager ? { select: ["id", "FirstName", "LastName"] } : true,
              },
            },
            // Legacy support - populate at order level too, but only with the
            // names the operational order UI needs.
            user_info: operationalManager ? { select: ["id", "FirstName", "LastName"] } : true,
            contract: operationalManager && !canReadFinancials
              ? { select: ["id", "Amount", "Status", "Type", "TaxPercent", "Date"] }
              : {
                  populate: {
                    contract_transactions: {
                      populate: {
                        payment_gateway: true,
                      },
                    },
                  },
                },
            order_items: {
              populate: {
                product_variation: {
                  populate: {
                    product: {
                      populate: ["CoverImage"],
                    },
                    product_variation_color: true,
                    product_variation_size: true,
                    product_variation_model: true,
                  },
                },
                product_color: true,
                product_size: true,
                product_variation_model: true,
              },
            },
            shipping: true,
            delivery_address: {
              populate: {
                shipping_city: {
                  populate: {
                    shipping_province: true,
                  },
                },
              },
            },
          },
        });

        if (!order) {
          return ctx.notFound("Order not found");
        }

        if (!isAdminUser) {
          if (!requesterId) {
            return ctx.unauthorized("Authentication required");
          }

          const orderOwnerId = order.user?.id ? Number(order.user.id) : null;
          if (!orderOwnerId || orderOwnerId !== requesterId) {
            return ctx.forbidden("You do not have permission to access this order");
          }
        }

        // Transform the response to match the frontend's expected structure
        // Check both order.user_info (legacy) and order.user.user_info (correct structure)
        const userInfo = order.user?.user_info || order.user_info;
        const sanitizedContract =
          operationalManager && !canReadFinancials && order.contract
            ? {
                id: order.contract.id,
                Amount: order.contract.Amount,
                Status: order.contract.Status,
                Type: order.contract.Type ?? null,
                TaxPercent: order.contract.TaxPercent ?? null,
                Date: order.contract.Date ?? null,
              }
            : order.contract;
        const safeOperationalUserInfo =
          operationalManager && userInfo
            ? {
                id: userInfo.id,
                FirstName: userInfo.FirstName ?? null,
                LastName: userInfo.LastName ?? null,
              }
            : userInfo;
        const transformedOrder = {
          ...order,
          ...(operationalManager
            ? { external_id: undefined, external_source: undefined, reserveGroupId: undefined }
            : {}),
          contract: sanitizedContract,
          user: order.user
            ? {
                data: {
                  id: order.user.id,
                  attributes: {
                    Phone: order.user.phone || null,
                    phone: order.user.phone || null,
                    ...(operationalManager
                      ? {}
                      : {
                          email: order.user.email,
                          username: order.user.username,
                        }),
                    user_info: safeOperationalUserInfo
                      ? {
                          data: {
                            id: safeOperationalUserInfo.id,
                            attributes: safeOperationalUserInfo,
                          },
                        }
                      : null,
                  },
                },
              }
            : null,
        };

        ctx.body = { data: transformedOrder };
      } catch (error) {
        ctx.badRequest("Error fetching order", {
          data: {
            success: false,
            error: (error as any).message,
          },
        });
      }
    },

    /**
     * Core `POST /orders`. Wraps the default create to record a "manual order created" admin
     * activity. `recordAdminAudit` (via the helper) gates on the actor's role, so only admin-created
     * orders are logged; customer checkout creates orders through cart finalize (which uses
     * `entityService.create` and bypasses this controller), so there is no double-logging.
     */
    async create(ctx) {
      if (!(await requireCapability(ctx, strapi, "order.manual.create"))) return;
      const response = await super.create(ctx);

      try {
        const actorId = ctx.state?.user?.id ? Number(ctx.state.user.id) : null;
        const orderId = Number((response as any)?.data?.id ?? (response as any)?.id);
        if (actorId && orderId) {
          const requestData = (ctx.request?.body as any)?.data ?? {};
          const ip = getClientIp(ctx);
          const userAgent = getUserAgent(ctx);
          void logAdminOrderCreate(
            strapi,
            orderId,
            actorId,
            { type: requestData.Type ?? null, status: requestData.Status ?? null },
            ip,
            userAgent,
          );
        }
      } catch (activityError) {
        strapi.log.error("Failed to log admin activity for order create", {
          error: (activityError as Error).message,
        });
      }

      return response;
    },

    /**
     * Core `PUT /orders/:id`. Wraps the default update to capture a human-readable admin activity
     * entry (who edited the order + a before/after diff of business fields). This is the only order
     * edit path with no logging of its own; the admin adjust/cancel/barcode flows use
     * `entityService.update` directly and so bypass this controller — no double-logging.
     */
    async update(ctx) {
      const { id } = ctx.params;
      const requestData = (ctx.request?.body as any)?.data ?? {};
      const requestsStatusChange = Object.prototype.hasOwnProperty.call(requestData, "Status");

      // Snapshot the whitelisted fields before the write so we can diff afterwards.
      let before: Record<string, any> | null = null;
      try {
        before = await strapi.db.query("api::order.order").findOne({
          where: { id },
          select: [...AUDITED_ORDER_FIELDS, "PaymentGateway"],
        });
      } catch (e) {
        before = null;
      }

      if (requestsStatusChange) {
        return ctx.badRequest("Use the order transition or cancellation operation", {
          data: {
            success: false,
            errorCode: "ORDER_STATUS_TRANSITION_REQUIRED",
          },
        });
      }

      const response = await super.update(ctx);

      // Fire-and-forget: build a normalized diff of only the whitelisted fields the caller actually
      // changed, then record it. `recordAdminAudit` (via the helper) verifies the actor is an admin
      // and silently no-ops otherwise, so non-admin/customer updates never produce an entry.
      try {
        const actorId = ctx.state?.user?.id ? Number(ctx.state.user.id) : null;
        if (before && actorId) {
          const changes: Record<string, { from?: any; to?: any }> = {};
          for (const field of AUDITED_ORDER_FIELDS) {
            if (!(field in requestData)) continue;
            const from = before[field] ?? null;
            const to = requestData[field] ?? null;
            if (String(from ?? "") !== String(to ?? "")) {
              changes[field] = { from, to };
            }
          }

          if (Object.keys(changes).length > 0) {
            const ip = getClientIp(ctx);
            const userAgent = getUserAgent(ctx);
            void logAdminOrderFieldUpdate(strapi, Number(id), changes, actorId, ip, userAgent);
          }
        }
      } catch (activityError) {
        strapi.log.error("Failed to log admin activity for order update", {
          orderId: id,
          error: (activityError as Error).message,
        });
      }

      return response;
    },

    async generateAnipoBarcode(ctx) {
      return generateAnipoBarcodeHandler(strapi as any, ctx);
    },

    async verifyPayment(ctx) {
      return verifyPaymentHandler(strapi as any, ctx);
    },

    async snappayCallback(ctx) {
      return snappayCallbackHandler(strapi as any, ctx);
    },

    async adminAdjustItems(ctx) {
      return adminAdjustItemsHandler(strapi as any, ctx);
    },

    async adminUpdateNotes(ctx) {
      if (!(await requireCapability(ctx, strapi, "order.notes.update"))) return;

      const orderId = Number(ctx.params.id);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return ctx.badRequest("Order id must be a positive integer");
      }

      const input = ctx.request?.body?.data || {};
      const rejected = Object.keys(input).filter(
        (field) => field !== "Description" && field !== "Note",
      );
      if (rejected.length > 0) {
        return ctx.badRequest(`Protected order fields cannot be updated: ${rejected.join(", ")}`);
      }

      const before = await strapi.db.query("api::order.order").findOne({
        where: { id: orderId },
        select: ["Description", "Note"],
      });
      if (!before) return ctx.notFound("Order not found");

      const updated = await strapi.entityService.update("api::order.order", orderId, {
        data: {
          ...(Object.prototype.hasOwnProperty.call(input, "Description")
            ? { Description: input.Description }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(input, "Note") ? { Note: input.Note } : {}),
        },
      });

      const changes: Record<string, { from?: any; to?: any }> = {};
      for (const field of ["Description", "Note"] as const) {
        if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
        if (String(before[field] ?? "") !== String(input[field] ?? "")) {
          changes[field] = { from: before[field] ?? null, to: input[field] ?? null };
        }
      }
      if (Object.keys(changes).length > 0) {
        await logAdminOrderFieldUpdate(
          strapi,
          orderId,
          changes,
          Number(ctx.state.user.id),
          getClientIp(ctx),
          getUserAgent(ctx),
        );
      }

      const sanitized = await this.sanitizeOutput(updated, ctx);
      return this.transformResponse(sanitized);
    },

    async adminCancel(ctx) {
      return adminCancelOrderHandler(strapi as any, ctx);
    },

    async adminPaymentOperation(ctx) {
      return adminPaymentOperationHandler(strapi as any, ctx);
    },

    async adminTransition(ctx) {
      return adminTransitionOrderHandler(strapi as any, ctx);
    },

    async adminVoidBarcode(ctx) {
      return adminVoidBarcodeHandler(strapi as any, ctx);
    },

    async decrementStockManual(ctx) {
      return decrementManualOrderStockHandler(strapi as any, ctx);
    },

    async checkPaymentStatus(ctx) {
      const { id } = ctx.params;

      try {
        const userId = await resolveCustomerTargetUserId(ctx, strapi as any);
        if (!userId) return;

        const order = await strapi.db.query("api::order.order").findOne({
          where: { id, user: { id: userId } },
          populate: {
            contract: {
              populate: {
                contract_transactions: { populate: { payment_gateway: true } },
              },
            },
          },
        });

        if (!order) {
          return ctx.forbidden("You do not have permission to access this order", {
            data: {
              success: false,
              error: "You do not have permission to access this order",
            },
          });
        }

        const attempt = await reconcileOrderPaymentAttempt(strapi as any, order);
        const contract = order.contract as any;
        const txList = Array.isArray(contract?.contract_transactions)
          ? contract.contract_transactions
          : [];
        const latestTx =
          [...txList].reverse().find((tx: any) => tx?.Status !== "Failed") ||
          [...txList].reverse()[0];
        const transactionId =
          attempt?.providerReference ||
          latestTx?.GatewayRefId ||
          latestTx?.external_id ||
          latestTx?.TrackId ||
          contract?.external_id ||
          undefined;
        const isSnappay = isSnappayGatewayValue(order.PaymentGateway);
        const paymentStatus =
          attempt?.Status ||
          (isSnappay
            ? "Unknown"
            : ["Started", "Shipment", "Done"].includes(order.Status)
              ? "Succeeded"
              : order.Status === "Cancelled"
                ? "Failed"
                : "Unknown");
        const isPaid = paymentStatus === "Succeeded";
        const canRetry = ["Failed", "Cancelled", "Expired"].includes(paymentStatus);

        return {
          data: {
            success: true,
            orderId: order.id,
            status: order.Status,
            paymentStatus,
            isPaid,
            paymentGateway: order.PaymentGateway || "Unknown",
            transactionId,
            attemptId: attempt?.attemptId,
            amountIrr: attempt?.Amount ? Number(attempt.Amount) : undefined,
            canRetry,
            nextAction: isPaid ? "view_order" : canRetry ? "return_to_cart" : "recheck",
            failureCode:
              attempt?.failureCode ||
              (isSnappay && !attempt ? "SNAPPAY_ATTEMPT_NOT_FOUND" : undefined),
            failureMessage:
              attempt?.failureMessage ||
              (isSnappay && !attempt ? "SnappPay payment requires reconciliation" : undefined),
            lastReconciledAt: attempt?.lastReconciledAt || undefined,
            authoritative: !isSnappay || Boolean(attempt),
          },
        };
      } catch (error) {
        return ctx.badRequest((error as any).message, {
          data: {
            success: false,
            error: (error as any).message,
          },
        });
      }
    },

    async reconcilePayment(ctx) {
      const orderId = Number(ctx.params?.id);
      const userId = await resolveCustomerTargetUserId(ctx, strapi as any);
      if (!userId) return;
      const order = await strapi.db.query("api::order.order").findOne({
        where: { id: orderId, user: { id: userId } },
        fields: ["id", "PaymentGateway"],
      } as any);
      if (!order) {
        return ctx.forbidden("You do not have permission to access this order");
      }
      if (isSnappayGatewayValue(order.PaymentGateway)) {
        await strapi
          .service("api::payment-gateway.snappay-orchestrator")
          .reconcileOrder(orderId, "customer_request");
      }
      return this.checkPaymentStatus(ctx);
    },

    async getActiveReserve(ctx) {
      return getActiveReserveHandler(strapi as Strapi, ctx);
    },

    async releaseReserve(ctx) {
      return releaseReserveHandler(strapi as Strapi, ctx);
    },

    async getMyOrders(ctx) {
      const { page = 1, pageSize = 10, reserveGroupId } = ctx.query;

      try {
        const userId = await resolveCustomerTargetUserId(ctx, strapi as any);
        if (!userId) return;

        const filters: { user: { id: number }; reserveGroupId?: string } = {
          user: { id: userId },
        };
        if (reserveGroupId && typeof reserveGroupId === "string") {
          filters.reserveGroupId = reserveGroupId;
        }
        const totalOrders = await strapi.db.query("api::order.order").count({ where: filters });

        const pageNumber = parseInt(page, 10);
        const limit = parseInt(pageSize, 10);
        const start = (pageNumber - 1) * limit;
        const pageCount = Math.ceil(totalOrders / limit);

        const orders = await strapi.db.query("api::order.order").findMany({
          where: filters,
          populate: {
            user: {
              fields: ["id", "phone", "username", "email"],
            },
            order_items: {
              populate: {
                product_variation: {
                  populate: {
                    product_variation_color: true,
                    product_variation_size: true,
                    product_variation_model: true,
                    product: { populate: ["CoverImage"] },
                  },
                },
                product_color: true,
                product_size: true,
                product_variation_model: true,
              },
            },
            shipping: true,
          },
          orderBy: { Date: "desc" },
          limit,
          offset: start,
        });

        return {
          data: orders,
          meta: {
            pagination: {
              page: pageNumber,
              pageSize: limit,
              pageCount,
              total: totalOrders,
            },
          },
        };
      } catch (error) {
        return ctx.badRequest((error as any).message, {
          data: { success: false, error: (error as any).message },
        });
      }
    },

    async getMyOrderDetail(ctx) {
      const { id } = ctx.params;

      try {
        const userId = await resolveCustomerTargetUserId(ctx, strapi as any);
        if (!userId) return;

        const orderId = Number(id);
        if (Number.isNaN(orderId)) {
          return ctx.badRequest("Order id must be a number", {
            data: { success: false, error: "INVALID_ID" },
          });
        }

        const query = (ctx.query || {}) as Record<string, unknown>;
        const logsPagination = parseDetailPagination(query, "logsPage", "logsPageSize");
        const transactionsPagination = parseDetailPagination(
          query,
          "transactionsPage",
          "transactionsPageSize",
        );

        const order = await strapi.db.query("api::order.order").findOne({
          where: { id: orderId, user: { id: userId } },
          populate: {
            order_items: {
              populate: {
                product_variation: {
                  populate: {
                    product_color: true,
                    product_size: true,
                    product_variation_model: true,
                    product: { populate: ["CoverImage"] },
                  },
                },
              },
            },
            shipping: true,
            delivery_address: {
              populate: {
                shipping_city: {
                  populate: {
                    shipping_province: true,
                  },
                },
              },
            },
            contract: transactionsPagination
              ? true
              : {
                  populate: {
                    contract_transactions: {
                      populate: {
                        payment_gateway: true,
                      },
                      orderBy: { Date: "asc" },
                    },
                  },
                },
            user: {
              fields: ["id", "phone", "username", "email"],
            },
          },
        });

        if (!order) {
          return ctx.notFound("Order not found", {
            data: { success: false, error: "NOT_FOUND" },
          });
        }

        const orderLogQuery: any = {
          where: { order: { id: orderId } },
          orderBy: { createdAt: "asc" },
        };
        let orderLogsMeta;
        if (logsPagination) {
          orderLogQuery.limit = logsPagination.pageSize;
          orderLogQuery.offset = logsPagination.offset;
          const total = await strapi.db.query("api::order-log.order-log").count({
            where: { order: { id: orderId } },
          });
          orderLogsMeta = {
            pagination: buildPaginationMeta(logsPagination.page, logsPagination.pageSize, total),
          };
        }
        const orderLogs = await strapi.db.query("api::order-log.order-log").findMany(orderLogQuery);

        let contractTransactions = order.contract?.contract_transactions ?? [];
        let contractTransactionsMeta;
        const contractId =
          typeof order.contract === "object" && order.contract?.id
            ? Number(order.contract.id)
            : Number(order.contract);
        if (transactionsPagination && contractId) {
          const transactionWhere = { contract: { id: contractId } };
          const total = await strapi.db
            .query("api::contract-transaction.contract-transaction")
            .count({ where: transactionWhere });
          contractTransactions = await strapi.db
            .query("api::contract-transaction.contract-transaction")
            .findMany({
              where: transactionWhere,
              populate: { payment_gateway: true },
              orderBy: { Date: "asc" },
              limit: transactionsPagination.pageSize,
              offset: transactionsPagination.offset,
            });
          contractTransactionsMeta = {
            pagination: buildPaginationMeta(
              transactionsPagination.page,
              transactionsPagination.pageSize,
              total,
            ),
          };
        }

        return {
          data: {
            ...order,
            contract_transactions: contractTransactions,
            orderLogs,
            ...(orderLogsMeta ? { orderLogsMeta } : {}),
            ...(contractTransactionsMeta ? { contractTransactionsMeta } : {}),
          },
        };
      } catch (error) {
        return ctx.badRequest((error as any).message, {
          data: { success: false, error: (error as any).message },
        });
      }
    },
  }),
);
