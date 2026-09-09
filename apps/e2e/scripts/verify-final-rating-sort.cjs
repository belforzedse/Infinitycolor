// Isolated local database only. Seed rated products, exercise the real product-card
// query, then delete every fixture.
const assert = require("node:assert/strict");
const path = require("node:path");

if (
  process.env.DATABASE_NAME !== "infinity_defects_e2e" ||
  process.env.DATABASE_PORT !== "29454"
) {
  throw new Error("Requires the isolated final-QA database fixture");
}

const appDir = path.resolve(__dirname, "../../backend");
const createStrapi = require(path.join(appDir, "node_modules/@strapi/strapi"));

(async () => {
  const app = createStrapi({
    appDir,
    distDir: path.join(appDir, "dist"),
    autoReload: false,
    serveAdminPanel: false,
  });
  await app.load();

  const uid = (name) => `api::${name}.${name}`;
  const query = (name) => app.db.query(uid(name));
  const created = [];

  try {
    const fixtures = [];
    for (const [label, rating] of [
      ["five", 5],
      ["three-a", 3],
      ["three-b", 3],
      ["one", 1],
      ["unrated", null],
    ]) {
      const product = await query("product").create({
        data: {
          Title: `final rating ${label}`,
          Slug: `final-rating-${label}`,
          Status: "Active",
          AverageRating: rating,
          RatingCount: rating === null ? 0 : 1,
        },
      });
      created.push(["product", product.id]);

      const stock = await query("product-stock").create({ data: { Count: 5 } });
      created.push(["product-stock", stock.id]);

      const variation = await query("product-variation").create({
        data: {
          SKU: `final-rating-${label}`,
          Price: 100000,
          IsPublished: true,
          product: product.id,
          product_stock: stock.id,
        },
      });
      created.push(["product-variation", variation.id]);
      fixtures.push({ id: product.id, rating });
    }

    const ids = fixtures.map(({ id }) => id);
    const service = app.service(uid("product"));
    const sortedIds = async (direction) => {
      const result = await service.findProductCards({
        filters: { id: { $in: ids } },
        sort: `AverageRating:${direction}`,
        pagination: { page: 1, pageSize: 10 },
      });
      return result.data.map((product) => product.id);
    };

    const five = fixtures.find(({ rating }) => rating === 5).id;
    const threes = fixtures
      .filter(({ rating }) => rating === 3)
      .map(({ id }) => id)
      .sort((a, b) => a - b);
    const one = fixtures.find(({ rating }) => rating === 1).id;
    const unrated = fixtures.find(({ rating }) => rating === null).id;

    assert.deepEqual(await sortedIds("desc"), [five, ...threes, one, unrated]);
    assert.deepEqual(await sortedIds("asc"), [one, ...threes, five, unrated]);
    console.log(
      "PASS: 1-, 3-, and 5-star products sort in both directions; unrated stays last and product id breaks ties.",
    );
  } finally {
    for (const [name, id] of created.reverse()) {
      await query(name).delete({ where: { id } });
    }
    await app.destroy();
  }
})().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
