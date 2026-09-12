import { atom } from "jotai";

/**
 * Shared "refetch your data" signal.
 *
 * It lives here rather than next to the super-admin table so storefront code
 * (`useFreshDataOnVisibility`, `useAccountFreshData`, …) can read it without
 * dragging `@/components/SuperAdmin/Table` — and with it `@tanstack/react-table`
 * and `qs` — into the shared client bundle of every storefront route.
 *
 * `@/components/SuperAdmin/Table` re-exports this same atom, so admin callers
 * and the atom's identity are unchanged.
 */
export const refreshTable = atom(true);
