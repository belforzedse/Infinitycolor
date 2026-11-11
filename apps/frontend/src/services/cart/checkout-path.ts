export function checkoutPath(path: string, baleCheckoutId?: string): string {
  if (!baleCheckoutId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}baleCheckoutId=${encodeURIComponent(baleCheckoutId)}`;
}
