import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  E2E_DEFAULT_ADMIN_PASSWORD,
  E2E_DEFAULT_ADMIN_PHONE,
  E2E_DEFAULT_CUSTOMER_PASSWORD,
  E2E_DEFAULT_CUSTOMER_PHONE,
  E2E_DEFAULT_EDITOR_PASSWORD,
  E2E_DEFAULT_EDITOR_PHONE,
  E2E_DEFAULT_FOUNDER_PASSWORD,
  E2E_DEFAULT_FOUNDER_PHONE,
  E2E_DEFAULT_STORE_MANAGER_PASSWORD,
  E2E_DEFAULT_STORE_MANAGER_PHONE,
} from "../fixtures/storefront";

export type E2EAuthRole =
  | "customer"
  | "admin"
  | "founder"
  | "store-manager"
  | "editor";

/** All seeded roles, in the order auth states are generated. */
export const E2E_AUTH_ROLES: E2EAuthRole[] = [
  "customer",
  "admin",
  "founder",
  "store-manager",
  "editor",
];

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const authStateDir = path.resolve(currentDir, "../.auth");

export function authStorageStatePath(role: E2EAuthRole) {
  return path.join(authStateDir, `${role}.json`);
}

type Credentials = { phone: string; password: string };

const DEFAULT_CREDENTIALS: Record<E2EAuthRole, Credentials> = {
  customer: { phone: E2E_DEFAULT_CUSTOMER_PHONE, password: E2E_DEFAULT_CUSTOMER_PASSWORD },
  admin: { phone: E2E_DEFAULT_ADMIN_PHONE, password: E2E_DEFAULT_ADMIN_PASSWORD },
  founder: { phone: E2E_DEFAULT_FOUNDER_PHONE, password: E2E_DEFAULT_FOUNDER_PASSWORD },
  "store-manager": {
    phone: E2E_DEFAULT_STORE_MANAGER_PHONE,
    password: E2E_DEFAULT_STORE_MANAGER_PASSWORD,
  },
  editor: { phone: E2E_DEFAULT_EDITOR_PHONE, password: E2E_DEFAULT_EDITOR_PASSWORD },
};

/** Env var override prefix per role, e.g. E2E_CUSTOMER_PHONE / E2E_STORE_MANAGER_PASSWORD. */
const ENV_PREFIX: Record<E2EAuthRole, string> = {
  customer: "E2E_CUSTOMER",
  admin: "E2E_ADMIN",
  founder: "E2E_FOUNDER",
  "store-manager": "E2E_STORE_MANAGER",
  editor: "E2E_EDITOR",
};

export function authCredentials(role: E2EAuthRole): Credentials {
  const prefix = ENV_PREFIX[role];
  const defaults = DEFAULT_CREDENTIALS[role];
  return {
    phone: process.env[`${prefix}_PHONE`]?.trim() || defaults.phone,
    password: process.env[`${prefix}_PASSWORD`]?.trim() || defaults.password,
  };
}

/** Env var holding a pre-seeded user id for the role (used when E2E_SEED_MODE=skip). */
export function authUserIdEnvName(role: E2EAuthRole) {
  return `${ENV_PREFIX[role]}_USER_ID`;
}
