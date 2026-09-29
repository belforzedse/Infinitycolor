export type AdaptiveRouteGroup =
  | "home"
  | "plp"
  | "search"
  | "pdp"
  | "cart"
  | "checkout"
  | "auth"
  | "account"
  | "blog"
  | "other";

export function getAdaptiveRouteGroup(
  pathname: string,
  hasSearchQuery = false,
): AdaptiveRouteGroup {
  if (!pathname || pathname === "/") return "home";
  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0]?.toLowerCase() || "";
  const second = segments[1]?.toLowerCase() || "";

  if (hasSearchQuery && (first === "plp" || first === "categories")) {
    return "search";
  }
  // /offer?type=… is a server-ranked listing on the normal PLP.
  if (first === "plp" || first === "categories" || first === "offer") return "plp";
  if (first === "search") return "search";
  if (first === "pdp") return "pdp";
  if (first === "cart") return "cart";
  if (first === "checkout") return "checkout";
  if (
    first === "payment" ||
    (first === "orders" &&
      ["payment-callback", "success", "failure"].includes(second))
  ) {
    return "checkout";
  }
  if (first === "auth") return "auth";
  if (
    first === "account" ||
    first === "addresses" ||
    first === "wallet" ||
    first === "favorites" ||
    first === "password" ||
    first === "privileges" ||
    first === "orders"
  ) {
    return "account";
  }
  if (first === "blog") return "blog";
  return "other";
}
