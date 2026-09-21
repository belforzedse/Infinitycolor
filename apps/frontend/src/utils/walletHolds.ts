import type { WalletHold } from "@/services/wallet";

/**
 * Presentation helpers for wallet credit committed to an unfinished payment.
 *
 * The defect these exist to fix is not that the money is held — a split payment
 * has to commit the wallet leg before handing the shopper to the gateway — but
 * that every surface showed the gross balance and said nothing, so the money
 * simply looked gone. Saying "X is reserved for an unfinished payment and comes
 * back by itself, at the latest by <time>" costs one line and removes the whole
 * reason to contact support.
 */

export const toToman = (irr: number): number => Math.round(Number(irr || 0) / 10);

export const formatToman = (irr: number): string => toToman(irr).toLocaleString("fa-IR");

/** Persian date/time for the "comes back by" bound. */
export function formatHoldDeadline(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("fa-IR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(parsed);
  } catch {
    return null;
  }
}

/** The hold a shopper is most likely asking about: the newest live one. */
export function primaryHold(holds: WalletHold[] | undefined): WalletHold | null {
  if (!Array.isArray(holds) || holds.length === 0) return null;
  return holds[0];
}

/** True while at least one hold is still being resolved with the provider. */
export const holdsAreReconciling = (holds: WalletHold[] | undefined): boolean =>
  Array.isArray(holds) && holds.some((hold) => hold.state === "reconciling");

/**
 * The sentence shown wherever a balance is shown.
 *
 * Deliberately never says "failed" or "lost": at the moment this renders the
 * payment may still succeed, and telling a shopper mid-payment that their money
 * is gone would be both alarming and wrong.
 */
export function heldBalanceMessage(
  heldIrr: number,
  holds?: WalletHold[],
): string | null {
  if (!heldIrr || heldIrr <= 0) return null;
  const deadline = formatHoldDeadline(primaryHold(holds)?.boundAt);
  const amount = formatToman(heldIrr);
  return deadline
    ? `${amount} تومان برای یک پرداخت ناتمام رزرو شده است و حداکثر تا ساعت ${deadline} به‌طور خودکار آزاد می‌شود.`
    : `${amount} تومان برای یک پرداخت ناتمام رزرو شده است و پس از تعیین وضعیت پرداخت به‌طور خودکار آزاد می‌شود.`;
}

/** Short form for a tooltip or a chip. */
export function heldBalanceTooltip(heldIrr: number): string | null {
  if (!heldIrr || heldIrr <= 0) return null;
  return `${formatToman(heldIrr)} تومان درگیر یک پرداخت ناتمام است`;
}
