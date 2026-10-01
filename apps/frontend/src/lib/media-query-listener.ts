export function listenMediaQuery(
  query: MediaQueryList,
  listener: (event: MediaQueryListEvent) => void,
): () => void {
  if (
    typeof query.addEventListener === "function" &&
    typeof query.removeEventListener === "function"
  ) {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }
  if (typeof query.addListener === "function" && typeof query.removeListener === "function") {
    query.addListener(listener);
    return () => query.removeListener(listener);
  }
  return () => undefined;
}
