import http from "node:http";
import { deflateSync } from "node:zlib";

function png(id) {
  const width = 80,
    height = 100;
  const color = {
    1: [190, 190, 190],
    2: [120, 120, 120],
    20: [210, 45, 60],
    30: [235, 130, 160],
    40: [45, 80, 200],
  }[id] || [200, 200, 200];
  const bytes = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const start = y * (1 + width * 3) + 1 + x * 3;
      for (let c = 0; c < 3; c++)
        bytes[start + c] = x < 5 || x > 74 || y < 5 || y > 94 ? 245 : color[c];
    }
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    payload.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(bytes)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Local, disposable catalogue. No real account, upload or commerce endpoint is used.
const image = (id) => ({
  id,
  attributes: {
    name: `photo-${id}.png`,
    alternativeText: `photo ${id}`,
    caption: null,
    width: 800,
    height: 1000,
    formats: null,
    mime: "image/png",
    ext: ".png",
    url: `/uploads/gallery-photo-${id}.png`,
  },
});

export function product(single = false) {
  const variations = [];
  for (const color of single ? [1] : [1, 2, 3])
    for (const size of [1, 2])
      for (const model of [1, 2]) {
        const id = color * 100 + size * 10 + model;
        variations.push({
          id,
          attributes: {
            SKU: `SKU-${id}`,
            Price: String(id * 100),
            IsPublished: true,
            product_variation_color: {
              data: {
                id: color,
                attributes: {
                  Title: ["", "قرمز", "آبی", "سبز"][color],
                  ColorCode: ["", "#ff0000", "#0000ff", "#00ff00"][color],
                },
              },
            },
            product_variation_size: {
              data: { id: size, attributes: { Title: size === 1 ? "S" : "M" } },
            },
            product_variation_model: {
              data: {
                id: model,
                attributes: { Title: model === 1 ? "A" : "B" },
              },
            },
            product_stock: { data: { id, attributes: { Count: 10 } } },
          },
        });
      }
  return {
    id: single ? 902 : 901,
    attributes: {
      Title: "محصول آزمایشی گالری رنگ",
      Slug: single ? "gallery-single" : "gallery-colors",
      Description: "تصاویر محصول و تن‌خور",
      Status: "Active",
      removedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      CoverImage: { data: image(1) },
      Media: { data: [image(2)] },
      product_main_category: { data: null },
      product_other_categories: { data: [] },
      product_tags: { data: [] },
      product_faqs: { data: [] },
      product_variations: { data: variations },
      ColorGalleries: [
        {
          id: 7,
          color: { data: { id: 1, attributes: { Title: "قرمز" } } },
          Images: { data: [image(20), image(30)] },
        },
        {
          id: 8,
          color: { data: { id: 2, attributes: { Title: "آبی" } } },
          Images: { data: [image(30), image(40)] },
        },
      ],
    },
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:4310");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname.startsWith("/uploads/")) {
    // PNG ensures the production image policy does not need an SVG exception.
    res.setHeader("Content-Type", "image/png");
    res.end(png(Number(url.pathname.match(/photo-(\d+)/)?.[1])));
    return;
  }
  res.setHeader("Content-Type", "application/json");
  let body = {
    data: [],
    meta: { pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 } },
  };
  if (/\/products\/by-slug\/gallery-(colors|single)$/.test(url.pathname))
    body = { data: product(url.pathname.endsWith("single")) };
  else if (url.pathname === "/api/auth/self") {
    res.statusCode = 401;
    body = { error: { status: 401, message: "Unauthorized" } };
  } else if (url.pathname.includes("/settings"))
    body = { data: { id: 1, attributes: { StoreName: "Infinity test" } } };
  else if (url.pathname.includes("/site-identity"))
    body = { data: { id: 1, attributes: {} } };
  else if (/\/products\/by-slug\//.test(url.pathname)) {
    res.statusCode = 404;
    body = { data: null };
  }
  res.end(JSON.stringify(body));
});
server.listen(4311, "127.0.0.1", () =>
  console.info("Color gallery fixture: http://localhost:4311"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
