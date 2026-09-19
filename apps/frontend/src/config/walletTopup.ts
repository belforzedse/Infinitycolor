/**
 * Storefront kill switch for starting wallet top-ups.
 *
 * This is intentionally separate from the backend switch. Turning the UI off
 * must not stop callbacks, verification, reconciliation, or status polling for
 * payments that are already in flight.
 */
export function isWalletTopupUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED === "true";
}
