/** Current-device logout is completed as a top-level central-auth navigation. */
import { centralLogoutUrl } from "@/lib/central-auth";

export { clearUserStorage } from "@/utils/userStorage";

export async function performLogout(): Promise<void> {
  if (typeof window === "undefined") return;
  window.location.assign(centralLogoutUrl());
}
