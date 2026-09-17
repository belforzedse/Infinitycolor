import type { Strapi } from "@strapi/strapi";
import * as Sentry from "@sentry/node";
import { mapOrderStatusToAnipo } from "../../../shipping/services/anipo";

/** States that mean the parcel was (or is being) registered at Anipo. */
const REGISTERED_ANIPO_STATES = new Set([
  "Pending",
  "Issued",
  "NeedsAttention",
  "Stopped",
]);

export type AnipoCancelSnapshot = {
  shippingBarcode?: string | null;
  anipoSubmittedAt?: string | Date | null;
  anipoBarcodeState?: string | null;
};

type AnipoStatusService = {
  updateOrderStatus: (
    orderCode: string,
    orderStatus: string,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
};

export function captureAnipoCancelSnapshot(order: {
  ShippingBarcode?: string | null;
  AnipoSubmittedAt?: string | Date | null;
  AnipoBarcodeState?: string | null;
}): AnipoCancelSnapshot {
  return {
    shippingBarcode: order.ShippingBarcode ?? null,
    anipoSubmittedAt: order.AnipoSubmittedAt ?? null,
    anipoBarcodeState: order.AnipoBarcodeState ?? null,
  };
}

export function shouldNotifyAnipoParcelCancelled(
  snapshot: AnipoCancelSnapshot,
): boolean {
  if (String(snapshot.shippingBarcode || "").trim()) return true;
  if (snapshot.anipoSubmittedAt) return true;
  return REGISTERED_ANIPO_STATES.has(String(snapshot.anipoBarcodeState || ""));
}

/**
 * Best-effort Anipo «لغو شده» after Infinity cancel commits.
 * Never throws — Anipo downtime must not roll back or fail cancel.
 */
export async function notifyAnipoParcelCancelled(
  strapi: Strapi,
  orderId: number,
  snapshot: AnipoCancelSnapshot,
): Promise<void> {
  if (!shouldNotifyAnipoParcelCancelled(snapshot)) return;

  const cancelledLabel = mapOrderStatusToAnipo("Cancelled");
  let providerError: string | null = null;

  try {
    const anipo = strapi.service("api::shipping.anipo") as AnipoStatusService;
    const result = await anipo.updateOrderStatus(String(orderId), cancelledLabel);
    if (!result?.ok) {
      providerError = String(result?.error || "anipo_status_update_failed");
    }
  } catch (error: unknown) {
    providerError =
      error instanceof Error
        ? error.message
        : String(error || "anipo_status_update_failed");
  }

  if (!providerError) {
    try {
      await strapi.db.query("api::order.order").update({
        where: { id: orderId },
        data: {
          AnipoLastCheckedAt: new Date(),
          AnipoLastMessage: "Anipo parcel marked cancelled (لغو شده)",
        },
      } as any);
    } catch (updateError: unknown) {
      strapi.log.error("Failed to persist Anipo cancel success message", {
        orderId,
        error:
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
      });
    }
    return;
  }

  strapi.log.error("Anipo parcel cancel notify failed", {
    orderId,
    error: providerError,
  });

  try {
    Sentry.captureMessage("anipo.parcel_cancel_failed", {
      level: "error",
      tags: { area: "shipping", provider: "anipo", stage: "cancel" },
      extra: { orderId, error: providerError.slice(0, 300) },
    });
  } catch {
    // A failed report must not affect order cancellation.
  }

  try {
    await strapi.db.query("api::order.order").update({
      where: { id: orderId },
      data: {
        AnipoLastCheckedAt: new Date(),
        AnipoLastMessage: `Anipo cancel failed: ${providerError}`.slice(0, 500),
      },
    } as any);
  } catch (updateError: unknown) {
    strapi.log.error("Failed to persist Anipo cancel failure message", {
      orderId,
      error:
        updateError instanceof Error
          ? updateError.message
          : String(updateError),
    });
  }
}
