import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  E2E_DEFAULT_ADMIN_PASSWORD,
  E2E_DEFAULT_ADMIN_PHONE,
  E2E_DEFAULT_CUSTOMER_PASSWORD,
  E2E_DEFAULT_CUSTOMER_PHONE,
  E2E_DEFAULT_CUSTOMER_B_PASSWORD,
  E2E_DEFAULT_CUSTOMER_B_PHONE,
  E2E_DEFAULT_EDITOR_PASSWORD,
  E2E_DEFAULT_EDITOR_PHONE,
  E2E_DEFAULT_FOUNDER_PASSWORD,
  E2E_DEFAULT_FOUNDER_PHONE,
  E2E_DEFAULT_FINANCE_PASSWORD,
  E2E_DEFAULT_FINANCE_PHONE,
  E2E_DEFAULT_SELLER_1_PASSWORD,
  E2E_DEFAULT_SELLER_1_PHONE,
  E2E_DEFAULT_SELLER_2_PASSWORD,
  E2E_DEFAULT_SELLER_2_PHONE,
  E2E_DEFAULT_STORE_MANAGER_PASSWORD,
  E2E_DEFAULT_STORE_MANAGER_PHONE,
  E2E_DEFAULT_STORE_MANAGER_2_PASSWORD,
  E2E_DEFAULT_STORE_MANAGER_2_PHONE,
} from "../fixtures/storefront";

export type E2EAuthRole =
  | "customer"
  | "customer-b"
  | "admin"
  | "founder"
  | "finance"
  | "seller-1"
  | "seller-2"
  | "store-manager"
  | "store-manager-2"
  | "editor";

/** All seeded roles, in the order auth states are generated. */
export const E2E_AUTH_ROLES: E2EAuthRole[] = [
  "customer",
  "customer-b",
  "admin",
  "founder",
  "finance",
  "seller-1",
  "seller-2",
  "store-manager",
  "store-manager-2",
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
  "customer-b": { phone: E2E_DEFAULT_CUSTOMER_B_PHONE, password: E2E_DEFAULT_CUSTOMER_B_PASSWORD },
  admin: { phone: E2E_DEFAULT_ADMIN_PHONE, password: E2E_DEFAULT_ADMIN_PASSWORD },
  founder: { phone: E2E_DEFAULT_FOUNDER_PHONE, password: E2E_DEFAULT_FOUNDER_PASSWORD },
  finance: { phone: E2E_DEFAULT_FINANCE_PHONE, password: E2E_DEFAULT_FINANCE_PASSWORD },
  "seller-1": { phone: E2E_DEFAULT_SELLER_1_PHONE, password: E2E_DEFAULT_SELLER_1_PASSWORD },
  "seller-2": { phone: E2E_DEFAULT_SELLER_2_PHONE, password: E2E_DEFAULT_SELLER_2_PASSWORD },
  "store-manager": {
    phone: E2E_DEFAULT_STORE_MANAGER_PHONE,
    password: E2E_DEFAULT_STORE_MANAGER_PASSWORD,
  },
  "store-manager-2": {
    phone: E2E_DEFAULT_STORE_MANAGER_2_PHONE,
    password: E2E_DEFAULT_STORE_MANAGER_2_PASSWORD,
  },
  editor: { phone: E2E_DEFAULT_EDITOR_PHONE, password: E2E_DEFAULT_EDITOR_PASSWORD },
};

/** Env var override prefix per role, e.g. E2E_CUSTOMER_PHONE / E2E_STORE_MANAGER_PASSWORD. */
const ENV_PREFIX: Record<E2EAuthRole, string> = {
  customer: "E2E_CUSTOMER",
  "customer-b": "E2E_CUSTOMER_B",
  admin: "E2E_ADMIN",
  founder: "E2E_FOUNDER",
  finance: "E2E_FINANCE",
  "seller-1": "E2E_SELLER_1",
  "seller-2": "E2E_SELLER_2",
  "store-manager": "E2E_STORE_MANAGER",
  "store-manager-2": "E2E_STORE_MANAGER_2",
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
