// Strapi v4 fills an empty scope with the route's own action. Reuse the
// existing customer cart permission, then require ownership in the handler.
const storefrontAuth = { scope: ["api::cart.cart.getMyCart"] };

export default {
  routes: [
    {
      method: "GET", path: "/bale/v1/inventory", handler: "bale-checkout.inventory",
      config: { auth: false },
    },
    {
      method: "POST", path: "/bale/v1/checkouts", handler: "bale-checkout.create",
      config: { auth: false },
    },
    {
      method: "GET", path: "/bale/v1/checkouts/:checkoutId", handler: "bale-checkout.status",
      config: { auth: false },
    },
    {
      method: "GET", path: "/bale/v1/products", handler: "bale-checkout.products",
      config: { auth: false },
    },
    {
      method: "GET", path: "/bale/v1/products/:productId", handler: "bale-checkout.product",
      config: { auth: false },
    },
    {
      method: "GET", path: "/bale/v1/provinces", handler: "bale-checkout.provinces",
      config: { auth: false },
    },
    {
      method: "GET", path: "/bale/v1/provinces/:provinceId/cities", handler: "bale-checkout.cities",
      config: { auth: false },
    },
    {
      method: "POST", path: "/bale/v1/quote", handler: "bale-checkout.quote",
      config: { auth: false },
    },
    {
      method: "GET", path: "/bale/v1/orders", handler: "bale-checkout.orders",
      config: { auth: false },
    },
    {
      method: "POST", path: "/bale/checkout/:checkoutId/claim", handler: "bale-checkout.claim",
      config: { auth: storefrontAuth },
    },
    {
      method: "GET", path: "/bale/checkout/:checkoutId", handler: "bale-checkout.read",
      config: { auth: storefrontAuth },
    },
  ],
};
