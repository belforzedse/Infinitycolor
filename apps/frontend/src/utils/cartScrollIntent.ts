let pending = false;
export function requestCartScrollTop() { pending = true; }
export function consumeCartScrollTop() {
  const value = pending;
  pending = false;
  return value;
}
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => { pending = false; });
}
