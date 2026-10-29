import { publicProductFilters } from "./productVisibility";

// Oppsi is marked in imported titles, including joined spellings such as کتOPPSI.
// This is a discovery rule: direct product links, carts and staff reads still work.
export const OPPSI_TITLE_TERM = "oppsi";

export function publicProductDiscoveryFilters(oppsi = false) {
  return {
    ...publicProductFilters(),
    Title: oppsi
      ? { $containsi: OPPSI_TITLE_TERM }
      : { $notContainsi: OPPSI_TITLE_TERM },
  };
}
