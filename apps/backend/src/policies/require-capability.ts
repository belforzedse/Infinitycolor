import type { Strapi } from "@strapi/strapi";
import { isAdminCapability, type AdminCapability } from "@repo/auth-core";
import { requireCapability } from "../utils/adminAuthorization";

type CapabilityPolicyConfig = { capability?: AdminCapability };

export default async (
  policyContext: any,
  config: CapabilityPolicyConfig = {},
  { strapi }: { strapi: Strapi },
) => {
  if (!isAdminCapability(config.capability)) {
    strapi.log.error("Capability policy denied a route with missing or unknown configuration", {
      capability: config.capability ?? null,
    });
    return false;
  }
  return Boolean(await requireCapability(policyContext, strapi, config.capability));
};
