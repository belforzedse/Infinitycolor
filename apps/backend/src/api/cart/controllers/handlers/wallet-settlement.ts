import type { Strapi } from "@strapi/strapi";
import { consumeOrderReservation } from "../../../../utils/stockReservations";
import { deductWalletBalanceAtomic } from "../../../local-user-wallet/services/local-user-wallet";

export async function settleOrderWithWallet(
  strapi: Strapi,
  params: {
    userId: number;
    orderId: number;
    contractId: number;
    paymentAttemptId: number;
    attemptId: string;
    totalToman: number;
    discountToman: number;
  },
) {
  const {
    userId,
    orderId,
    contractId,
    paymentAttemptId,
    attemptId,
    totalToman,
    discountToman,
  } = params;
  const totalIrr = Math.round(totalToman) * 10;
  const discountIrr = Math.round(discountToman) * 10;
  const walletReference = `wallet-order-${orderId}-${attemptId}`;

  return strapi.db.transaction(async ({ trx }) => {
    // Serialize every settlement for this durable attempt before reading its
    // state. Locking the wallet alone is insufficient: a second request can
    // wait for the first debit, then debit again after observing the first
    // ledger entry. The attempt row is the business-operation lock.
    await trx.raw(
      "SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE",
      [paymentAttemptId],
    );
    const currentAttempt: any = await strapi.db
      .query("api::payment-attempt.payment-attempt")
      .findOne({ where: { id: paymentAttemptId }, transacting: trx } as any);
    if (currentAttempt?.Status === "Succeeded") {
      return { success: true, reference: currentAttempt.providerReference };
    }
    if (currentAttempt?.Status !== "Created") {
      throw new Error(`PAYMENT_ATTEMPT_NOT_SETTLEABLE:${currentAttempt?.Status || "missing"}`);
    }

    const walletResult = await deductWalletBalanceAtomic(strapi, userId, totalIrr, trx);
    if (!walletResult.success || !walletResult.walletId) {
      throw new Error(`WALLET_DEBIT_FAILED:${walletResult.error || "unknown"}`);
    }

    const existingWalletTx = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findOne({ where: { ReferenceId: walletReference }, transacting: trx } as any);
    if (!existingWalletTx) {
      await strapi.db
        .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
        .create({
          data: {
            Amount: totalIrr,
            Type: "Minus",
            Date: new Date(),
            Cause: "Order Payment",
            ReferenceId: walletReference,
            user_wallet: walletResult.walletId,
          },
          transacting: trx,
        } as any);
    }

    let walletGateway: any = await strapi.db
      .query("api::payment-gateway.payment-gateway")
      .findOne({ where: { Title: "Wallet" }, transacting: trx } as any);
    if (!walletGateway) {
      walletGateway = await strapi.db
        .query("api::payment-gateway.payment-gateway")
        .create({
          data: {
            Title: "Wallet",
            IsActive: true,
            Description: "Infinity wallet balance",
          },
          transacting: trx,
        } as any);
    }

    const existingContractTx = await strapi.db
      .query("api::contract-transaction.contract-transaction")
      .findOne({
        where: {
          contract: { id: contractId },
          external_source: "Wallet",
          external_id: walletReference,
        },
        transacting: trx,
      } as any);
    if (!existingContractTx) {
      await strapi.db
        .query("api::contract-transaction.contract-transaction")
        .create({
          data: {
            Type: "Gateway",
            Amount: totalIrr,
            DiscountAmount: discountIrr,
            Step: 1,
            Status: "Success",
            TrackId: walletReference,
            external_id: walletReference,
            external_source: "Wallet",
            contract: contractId,
            payment_gateway: walletGateway.id,
            Date: new Date(),
          },
          transacting: trx,
        } as any);
    }

    const consumed = await consumeOrderReservation(strapi, orderId, trx);
    if (consumed.outcome !== "consumed") {
      throw new Error(
        `STOCK_RESERVATION_CONSUME_FAILED:${consumed.expired ? "expired" : "not_consumed"}`,
      );
    }

    await strapi.db.query("api::contract.contract").update({
      where: { id: contractId },
      data: {
        Status: "Confirmed",
        external_source: "Wallet",
        external_id: walletReference,
      },
      transacting: trx,
    } as any);
    await strapi.db.query("api::order.order").update({
      where: { id: orderId },
      data: {
        Status: "Started",
        PaymentGateway: "Wallet",
        external_source: "Wallet",
        external_id: walletReference,
      },
      transacting: trx,
    } as any);
    await strapi.db.query("api::payment-attempt.payment-attempt").update({
      where: { id: paymentAttemptId },
      data: {
        Status: "Succeeded",
        providerReference: walletReference,
        providerResponse: { walletTransactionReference: walletReference },
        resolvedAt: new Date(),
      },
      transacting: trx,
    } as any);
    await strapi.db.query("api::order-log.order-log").create({
      data: {
        order: orderId,
        Action: "Update",
        Description: "Wallet payment settled atomically",
        Changes: { attemptId, reference: walletReference },
      },
      transacting: trx,
    } as any);

    return {
      success: true,
      reference: walletReference,
      newBalance: walletResult.newBalance,
    };
  });
}
