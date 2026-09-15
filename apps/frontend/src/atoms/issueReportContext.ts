import { atom } from "jotai";

/**
 * The order id of the page currently on screen, if any. Set by pages that
 * know their order (e.g. `/payment/result`) as early as possible -- before
 * any fetch that could itself fail -- and cleared on unmount, so the issue
 * report widget can point a report straight at the order in question instead
 * of leaving an admin to guess which of a customer's orders it's about.
 */
export const currentOrderContextAtom = atom<{ orderId: number } | null>(null);
