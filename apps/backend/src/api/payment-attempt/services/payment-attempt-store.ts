import type { Strapi } from "@strapi/strapi";

const UID = "api::payment-attempt.payment-attempt" as const;

export async function findOrderPaymentAttempt(strapi: Strapi, orderId: number, trx?: any) {
  return strapi.db.query(UID).findOne({
    where: { order: { id: orderId } },
    populate: { order: true, contract: true },
    orderBy: { createdAt: "desc" },
    ...(trx ? { transacting: trx } : {}),
  } as any);
}

export async function findPaymentAttemptByProviderReference(
  strapi: Strapi,
  gateway: string,
  providerReference: string,
  trx?: any,
) {
  return strapi.db.query(UID).findOne({
    where: { providerReference, Gateway: gateway },
    populate: { order: true, contract: true },
    ...(trx ? { transacting: trx } : {}),
  } as any);
}

export async function updatePaymentAttempt(
  strapi: Strapi,
  id: number,
  data: Record<string, unknown>,
  trx?: any,
) {
  return strapi.db.query(UID).update({
    where: { id },
    data,
    ...(trx ? { transacting: trx } : {}),
  } as any);
}
