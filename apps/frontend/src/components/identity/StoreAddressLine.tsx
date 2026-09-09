import type { IdentityStore } from "@/types/site-identity";

/**
 * Keep the Persian store title in its own text run. Concatenating
 * `name + ": " + address` lets the ASCII colon join onto «کاووس» and some
 * Peyda fallbacks then render that word as replacement glyphs.
 */
export default function StoreAddressLine({ store }: { store: IdentityStore }) {
  if (!store.name && !store.address) return null;

  if (!store.name) return store.address ?? null;
  if (!store.address) return store.name;

  return (
    <>
      <span>{store.name}</span>
      <span>{" : "}</span>
      <span>{store.address}</span>
    </>
  );
}
