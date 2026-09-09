export type WalletCustomer = {
  id: number;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  isActive: boolean;
};

function isWalletCustomer(value: unknown): value is WalletCustomer {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { id?: unknown }).id === "number";
}

function customersFromUnknown(value: unknown): WalletCustomer[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isWalletCustomer);
}

/**
 * `apiClient.get` returns the Strapi envelope `{ data, meta }`. Some callers
 * pass that envelope, others pass `response.data` after a generic mix-up.
 */
export function unwrapCustomerSearchResults(response: unknown): WalletCustomer[] {
  const direct = customersFromUnknown(response);
  if (direct.length > 0 || Array.isArray(response)) return direct;

  if (!response || typeof response !== "object") return [];
  const nested = (response as { data?: unknown }).data;
  const fromData = customersFromUnknown(nested);
  if (fromData.length > 0 || Array.isArray(nested)) return fromData;

  if (nested && typeof nested === "object") {
    return customersFromUnknown((nested as { data?: unknown }).data);
  }
  return [];
}

export function formatCustomerName(
  customer: Pick<WalletCustomer, "firstName" | "lastName">,
): string {
  return `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
}
