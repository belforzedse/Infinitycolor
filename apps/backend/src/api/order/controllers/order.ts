// @ts-nocheck
/**
 * order controller (slim delegator)
 */

import { factories } from "@strapi/strapi";
import { Strapi } from "@strapi/strapi";
import { generateAnipoBarcodeHandler } from "./helpers/generateBarcode";
import { checkAnipoBarcodeHandler } from "./helpers/checkAnipoBarcode";
import { verifyPaymentHandler } from "./helpers/payment";
import { snappayCallbackHandler } from "./helpers/snappayCallback";
import { adminAdjustItemsHandler } from "./helpers/adminAdjustItems";
import { adminCancelOrderHandler } from "./helpers/adminCancel";
import { adminPaymentOperationHandler } from "./helpers/adminPaymentOperation";
import { adminVoidBarcodeHandler } from "./helpers/adminVoidBarcode";
import { adminWalletRecoveryHandler } from "./helpers/adminWalletRecovery";
import { adminUpdateAddressHandler } from "./helpers/adminUpdateAddress";
import { decrementManualOrderStockHandler } from "./helpers/manualOrderStock";
import { getActiveReserveHandler } from "./handlers/getActiveReserve";
import { releaseReserveHandler } from "./handlers/releaseReserve";
import {
  getMyReserveGroupHandler,
  listMyReserveGroupsHandler,
} from "./handlers/myReserveGroups";
import { logAdminOrderCreate, logAdminOrderFieldUpdate } from "../../../utils/adminActivity";
import { getClientIp, getUserAgent } from "../../../utils/getClientIp";
import { adminTransitionOrderHandler } from "./helpers/adminTransition";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import { walletHoldStateFor } from "../../payment-attempt/services/payment-attempt-outcome";
import { hasCapability, normalizeAdminRole } from "@repo/auth-core";
import { requireCapability, resolveAdminActor } from "../../../utils/adminAuthorization";
import {
  findOrderPaymentAttempt,
  reconcileOrderPaymentAttempt,
} from "../../payment-attempt/services/payment-attempt";
import { isSnappayGatewayValue } from "../../payment-gateway/services/checkout-gateway-availability";
import { isOperationalManagerRequest } from "../../../utils/operationalCommerce";
import {
  projectOrderReserve,
  withReserveProjection,
} from "../../reserve-group/lib/reserve-group";

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
            "AnipoBarcodeState",
            "AnipoSubmittedAt",
            "AnipoLastCheckedAt",
            "AnipoPollingDeadlineAt",
            "AnipoIssuedAt",
            "AnipoCheckCount",
            "AnipoReadyToIssue",
            "AnipoProviderStatus",
            "AnipoLastMessage",
            "AnipoLastError",
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
                    // Falls back for a variation whose only dimension is a generic
                    // (non-color/size) attribute, e.g. a "pattern"/"design" term —
                    // otherwise the invoice prints the bare product title with no
                    // variant info at all.
                    selected_attribute_terms: {
                      populate: { product_attribute: true },
                    },
                  },
                },
                product_color: true,
                product_size: true,
                product_variation_model: true,
              },
            },
            shipping: true,
            reserve_shipment: true,
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
          // The reserve columns on the row are frozen at creation; the live view
          // comes from the group. Without this the admin detail screen would
          // offer fulfillment actions the server refuses (and vice versa).
          ...projectOrderReserve(order),
          hasSharedReserveAddress: Boolean(order.reserve_shipment?.id),
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
      return strapi.db.transaction(async ({ trx }) => {
        const response = await super.create(ctx);
        const actorId = ctx.state?.user?.id ? Number(ctx.state.user.id) : null;
        const orderId = Number((response as any)?.data?.id ?? (response as any)?.id);
        if (actorId && orderId) {
          const requestData = (ctx.request?.body as any)?.data ?? {};
          const ip = getClientIp(ctx);
          const userAgent = getUserAgent(ctx);
          await logAdminOrderCreate(
            strapi,
            orderId,
            actorId,
            { type: requestData.Type ?? null, status: requestData.Status ?? null },
            ip,
            userAgent,
            ctx.state?.user?.role?.name,
            trx,
          );
        }
        return response;
      });
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

      if (requestsStatusChange) {
        return ctx.badRequest("Use the order transition or cancellation operation", {
          data: {
            success: false,
            errorCode: "ORDER_STATUS_TRANSITION_REQUIRED",
          },
        });
      }

      return strapi.db.transaction(async ({ trx }) => {
        const before = await strapi.db.query("api::order.order").findOne({
          where: { id },
          select: [...AUDITED_ORDER_FIELDS, "PaymentGateway"],
        }) as Record<string, any> | null;
        const response = await super.update(ctx);
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
            await logAdminOrderFieldUpdate(
              strapi,
              Number(id),
              changes,
              actorId,
              ip,
              userAgent,
              ctx.state?.user?.role?.name,
              trx,
            );
          }
        }
        return response;
      });
    },

    async generateAnipoBarcode(ctx) {
      return generateAnipoBarcodeHandler(strapi as any, ctx);
    },

    async checkAnipoBarcode(ctx) {
      return checkAnipoBarcodeHandler(strapi as any, ctx);
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

      return strapi.db.transaction(async ({ trx }) => {
        const before = await strapi.db.query("api::order.order").findOne({
          where: { id: orderId },
          select: ["Description", "Note"],
          transacting: trx,
        } as any);
        if (!before) return ctx.notFound("Order not found");

        const updated = await strapi.db.query("api::order.order").update({
          where: { id: orderId },
          data: {
            ...(Object.prototype.hasOwnProperty.call(input, "Description")
              ? { Description: input.Description }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(input, "Note") ? { Note: input.Note } : {}),
          },
          transacting: trx,
        } as any);

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
            ctx.state?.user?.role?.name,
            trx,
          );
        }

        const sanitized = await this.sanitizeOutput(updated, ctx);
        return this.transformResponse(sanitized);
      });
    },

    async adminUpdateAddress(ctx) {
      return adminUpdateAddressHandler(strapi as any, ctx);
    },

    async adminCancel(ctx) {
      return adminCancelOrderHandler(strapi as any, ctx);
    },

    async adminPaymentOperation(ctx) {
      return adminPaymentOperationHandler(strapi as any, ctx);
    },

    /** Read-only operator diagnostics for an order's wallet hold and recovery. */
    async adminWalletRecovery(ctx) {
      return adminWalletRecoveryHandler(strapi as any, ctx);
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

    /**
     * Latest moment a live hold can still be held.
     *
     * SnappPay attempts are bounded by the reservation deferral ceiling, which
     * the expiry sweep enforces from the attempt's own age; every other gateway
     * is bounded by the order's reservation expiry. Read from the environment
     * at call time, exactly as the job does.
     */
    walletHoldBoundAt(attempt: any, order: any): string | undefined {
      if (isSnappayGatewayValue(attempt?.Gateway || order?.PaymentGateway)) {
        if (!attempt?.createdAt) return undefined;
        const hours = Number(process.env.SNAPPAY_RESERVATION_DEFER_MAX_HOURS || 1.5);
        const ceilingMs = (Number.isFinite(hours) && hours > 0 ? hours : 1.5) * 60 * 60 * 1000;
        return new Date(new Date(attempt.createdAt).getTime() + ceilingMs).toISOString();
      }
      return order?.ReservedUntil
        ? new Date(order.ReservedUntil).toISOString()
        : undefined;
    },

    async checkPaymentStatus(ctx) {
      const { id } = ctx.params;

      try {
        const userId = await resolveCustomerTargetUserId(ctx, strapi as any);
        if (!userId) return;

        const order = await strapi.db.query("api::order.order").findOne({
          where: { id, user: { id: userId } },
          populate: {
            shipping: { fields: ["Code", "Title"] },
            reserve_shipment: { populate: { rootOrder: true } },
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
        const shippingMethodCode =
          order.ShippingMethodCode || (order as any).shipping?.Code || null;
        const shippingMethodTitle =
          order.ShippingMethodTitle || (order as any).shipping?.Title || null;

        // Reserve facts are read from the group row, never from the order's frozen
        // columns, so the confirmation screen states the live deadline rather than
        // the one captured at checkout. `reserveAttached` distinguishes "you opened
        // a window" from "you joined one", which the shopper needs told explicitly.
        const reserveGroup = (order as any).reserve_shipment;
        const reserveOrderCount = reserveGroup?.id
          ? await strapi.db.query("api::order.order").count({
              where: { reserve_shipment: { id: reserveGroup.id } },
            })
          : 0;

        return {
          data: {
            success: true,
            reserveGroupId: reserveGroup?.groupKey ?? null,
            reserveExpiresAt: reserveGroup?.expiresAt ?? null,
            reserveState: reserveGroup?.State ?? null,
            reserveOrderCount,
            reserveAttached: reserveGroup?.rootOrder?.id
              ? Number(reserveGroup.rootOrder.id) !== Number(order.id)
              : undefined,
            orderId: order.id,
            status: order.Status,
            paymentStatus,
            isPaid,
            paymentGateway: order.PaymentGateway || "Unknown",
            shippingMethodCode,
            shippingMethodTitle,
            transactionId,
            attemptId: attempt?.attemptId,
            // `amountIrr` stays the order total. The two legs are reported
            // alongside it so the result page can show what came from the
            // wallet and what the bank carried.
            amountIrr: attempt?.Amount ? Number(attempt.Amount) : undefined,
            // Whether this checkout still has the shopper's credit committed.
            // "Active" is what makes the abandon action worth offering; once it
            // is Released or Captured the money is no longer in limbo.
            walletHoldStatus: attempt?.WalletHoldStatus || undefined,
            ...(Number(attempt?.WalletAmount || 0) > 0
              ? {
                  walletAmountIrr: Number(attempt.WalletAmount),
                  gatewayAmountIrr: Number(
                    attempt.GatewayAmount ??
                      Number(attempt.Amount || 0) - Number(attempt.WalletAmount),
                  ),
                }
              : {}),
            canRetry,
            nextAction: isPaid ? "view_order" : canRetry ? "return_to_cart" : "recheck",
            failureCode:
              attempt?.failureCode ||
              (isSnappay && !attempt ? "SNAPPAY_ATTEMPT_NOT_FOUND" : undefined),
            failureMessage:
              attempt?.failureMessage ||
              (isSnappay && !attempt ? "SnappPay payment requires reconciliation" : undefined),
            lastReconciledAt: attempt?.lastReconciledAt || undefined,
            // How the hold reads to the shopper right now, and the latest
            // moment it can still be held. The result page needs both to
            // promise an automatic release honestly instead of implying one it
            // cannot bound.
            ...(attempt?.WalletHoldStatus === "Active"
              ? {
                  walletHoldState: walletHoldStateFor(attempt),
                  walletHoldBoundAt: this.walletHoldBoundAt(attempt, order),
                  // The result page holds the manual release button back for a
                  // couple of minutes after the hold is taken, so a shopper who
                  // is still mid-payment is not offered a way to cancel it.
                  walletHeldAt: attempt.WalletHeldAt
                    ? new Date(attempt.WalletHeldAt).toISOString()
                    : undefined,
                }
              : {}),
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

    /**
     * Re-read the provider for one of the caller's own orders.
     *
     * `abandon: true` additionally carries the shopper's statement that they did
     * not pay — the signal that lets a SnappPay attempt stuck at `REGISTERED`
     * be reverted, which is what hands a wallet split's held credit back. It is
     * only a claim: the worker still reads `GET /status` first and honours the
     * payment if SnappPay says it happened. Everything else about the request is
     * unchanged, so the response is the same payment status as a plain poll.
     */
    async reconcilePayment(ctx) {
      const orderId = Number(ctx.params?.id);
      const userId = await resolveCustomerTargetUserId(ctx, strapi as any);
      if (!userId) return;
      const order = await strapi.db.query("api::order.order").findOne({
        where: { id: orderId, user: { id: userId } },
        fields: ["id", "Status", "PaymentGateway"],
      } as any);
      if (!order) {
        return ctx.forbidden("You do not have permission to access this order");
      }
      const body = (ctx.request as any)?.body || {};
      // A shopper can only abandon a checkout that is still trying to pay. An
      // order already carrying goods is never unwound from the storefront.
      const abandon =
        (body?.abandon === true || body?.abandon === "true") &&
        String(order.Status) === "Paying";
      let walletReleaseRequested = false;
      // Named so the storefront can tell "we queued your release" from "there
      // is nothing this button can do here". Only SnappPay has a provider call
      // behind the shopper's claim; a bank-gateway checkout is resolved by its
      // callback or by the reservation timeout, and offering a button that
      // silently does nothing is worse than not offering one.
      let walletReleaseReason: "queued" | "already_resolved" | "not_applicable" =
        "not_applicable";
      if (isSnappayGatewayValue(order.PaymentGateway)) {
        const orchestrator = strapi.service("api::payment-gateway.snappay-orchestrator");
        if (abandon) {
          strapi.log.info("Customer abandoned a SnappPay checkout", { orderId, userId });
          const outcome = await orchestrator.abandonOrder(
            orderId,
            "customer_abandoned_checkout",
          );
          walletReleaseRequested = outcome?.accepted === true;
          walletReleaseReason = walletReleaseRequested ? "queued" : "already_resolved";
        } else {
          await orchestrator.reconcileOrder(orderId, "customer_request");
        }
      }
      const response = await this.checkPaymentStatus(ctx);
      // Only ever reported for a claim that was actually recorded. A shopper
      // whose own `OK` return already reached us is told nothing about a
      // release, because none was queued and none is coming.
      if (abandon && response?.data) {
        response.data.walletReleaseRequested = walletReleaseRequested;
        response.data.walletReleaseReason = walletReleaseReason;
      }
      return response;
    },

    async getActiveReserve(ctx) {
      return getActiveReserveHandler(strapi as Strapi, ctx);
    },

    async releaseReserve(ctx) {
      return releaseReserveHandler(strapi as Strapi, ctx);
    },

    async listMyReserveGroups(ctx) {
      return listMyReserveGroupsHandler(strapi as Strapi, ctx);
    },

    async getMyReserveGroup(ctx) {
      return getMyReserveGroupHandler(strapi as Strapi, ctx);
    },

    async getMyOrders(ctx) {
      const { page = 1, pageSize = 10, reserveGroupId } = ctx.query;

      try {
        const userId = await resolveCustomerTargetUserId(ctx, strapi as any);
        if (!userId) return;

        const filters: {
          user: { id: number };
          reserve_shipment?: { groupKey: string };
        } = {
          user: { id: userId },
        };
        if (reserveGroupId && typeof reserveGroupId === "string") {
          filters.reserve_shipment = { groupKey: reserveGroupId };
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
                    // Falls back for a variation whose only dimension is a generic
                    // (non-color/size) attribute, e.g. a "pattern"/"design" term.
                    selected_attribute_terms: {
                      populate: { product_attribute: true },
                    },
                    product: { populate: ["CoverImage"] },
                  },
                },
                product_color: true,
                product_size: true,
                product_variation_model: true,
              },
            },
            shipping: true,
            reserve_shipment: true,
          },
          orderBy: { Date: "desc" },
          limit,
          offset: start,
        });

        return {
          // Reserve fields are projected from the group row, never read off the
          // frozen order columns -- see projectOrderReserve.
          data: orders.map((order: any) => withReserveProjection(order)),
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
                    product_variation_color: true,
                    product_variation_size: true,
                    product_variation_model: true,
                    // Falls back for a variation whose only dimension is a generic
                    // (non-color/size) attribute, e.g. a "pattern"/"design" term.
                    selected_attribute_terms: {
                      populate: { product_attribute: true },
                    },
                    product: { populate: ["CoverImage"] },
                  },
                },
                // The order line's own snapshot of the chosen variation, frozen at
                // checkout. Read this first: the variation may later be re-pointed or
                // unpublished, and only these columns say what the customer bought.
                product_color: true,
                product_size: true,
                product_variation_model: true,
              },
            },
            shipping: true,
            reserve_shipment: true,
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
            ...withReserveProjection(order),
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
