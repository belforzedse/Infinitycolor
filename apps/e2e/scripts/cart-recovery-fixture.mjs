import { createServer } from "node:http";

// Loopback-only catalog: no accounts, orders, credentials or production writes.
const product = {
  id: 900001,
  Title: "محصول آزمایشی سبد خرید",
  Slug: "cart-recovery-fixture",
  Status: "Active",
  Description: "",
  product_main_category: { id: 900002, Title: "پوشاک", Slug: "fixture" },
  product_other_categories: [],
  product_tags: [],
  Media: [],
  Files: [],
  product_variations: [
    {
      id: 900003,
      SKU: "CART-RECOVERY-FIXTURE",
      IsPublished: true,
      Price: 100000,
      product_stock: { id: 900004, Count: 3, reservedCount: 0 },
      product_variation_size: { id: 900005, Title: "L" },
    },
  ],
};

createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:4341");
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:4330");
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  let body = {
    data: [],
    meta: { pagination: { page: 1, pageSize: 30, pageCount: 0, total: 0 } },
  };
  if (url.pathname === "/api/products/by-slug/cart-recovery-fixture")
    body = { data: product };
  if (url.pathname === "/api/_health") body = { ok: true };
  if (url.pathname.includes("reviews"))
    body = { data: [], meta: body.meta, averageRating: 0, totalReviews: 0 };
  response.end(JSON.stringify(body));
}).listen(4341, "127.0.0.1");
