import type { Strapi } from "@strapi/strapi";
import fs from "node:fs/promises";
import path from "node:path";

type CityPayload = { province: string; cities: string[] };
type ShippingSeed = {
  Title: string;
  Price: number;
  IsActive?: boolean | null;
  Code?: string;
  SortOrder?: number;
  Description?: string;
  EstimatedDeliveryText?: string;
  localOnly?: boolean;
};

const DEFAULT_SHIPPINGS: ShippingSeed[] = [
  { Title: "ارسال با پست", Price: 69000, IsActive: true },
  { Title: "ارسال با تیپاکس", Price: 79000, IsActive: true },
  { Title: "ارسال با پیک", Price: 25000, IsActive: true },
  { Title: "دریافت حضوری", Price: 0, IsActive: true },
];

type ShippingBackfillContext = {
  golestanProvinceId?: number;
  gorganCityId?: number;
};

function getShippingDefaults(seed: ShippingSeed, context: ShippingBackfillContext) {
  const price = Number(seed.Price || 0);
  const base = {
    Code: seed.Code,
    SortOrder: seed.SortOrder ?? 0,
    Description: seed.Description,
    EstimatedDeliveryText: seed.EstimatedDeliveryText,
    Rules: [] as any[],
  };

  if (price === 69000) {
    return {
      ...base,
      Code: seed.Code || "post",
      SortOrder: seed.SortOrder ?? 10,
      EstimatedDeliveryText: seed.EstimatedDeliveryText || "تحویل با پست",
    };
  }
  if (price === 79000) {
    return {
      ...base,
      Code: seed.Code || "tipax",
      SortOrder: seed.SortOrder ?? 20,
      EstimatedDeliveryText: seed.EstimatedDeliveryText || "تحویل با تیپاکس",
    };
  }

  const localRule = {
    id: price === 0 ? "pickup-gorgan-golestan" : "local-courier-gorgan-golestan",
    title: "گرگان و استان گلستان",
    active: true,
    priority: 100,
    price,
    provinceIds: context.golestanProvinceId ? [context.golestanProvinceId] : [],
    cityIds: context.gorganCityId ? [context.gorganCityId] : [],
  };

  if (price === 25000) {
    return {
      ...base,
      Code: seed.Code || "local-courier",
      SortOrder: seed.SortOrder ?? 5,
      EstimatedDeliveryText: seed.EstimatedDeliveryText || "ویژه گرگان و گلستان",
      Rules: [localRule],
    };
  }

  return {
    ...base,
    Code: seed.Code || "pickup",
    SortOrder: seed.SortOrder ?? 30,
    EstimatedDeliveryText: seed.EstimatedDeliveryText || "ویژه گرگان و گلستان",
    Rules: [localRule],
  };
}

export async function ensureIranLocations(strapi: Strapi) {
  try {
    const forceReseed = process.env.FORCE_RESEED === "true";
    const provinceCount = await strapi.db.query("api::shipping-province.shipping-province").count();
    const cityCount = await strapi.db.query("api::shipping-city.shipping-city").count();
    const shippingCount = await strapi.db.query("api::shipping.shipping").count();
    const shouldSeedLocations = forceReseed || provinceCount === 0 || cityCount === 0;
    const shouldSeedShippings = forceReseed || shippingCount === 0;

    if (!forceReseed && provinceCount > 0 && cityCount > 0) {
      strapi.log.info(
        "✓ Iran locations already seeded (provinces=%d cities=%d). Set FORCE_RESEED=true to re-seed.",
        provinceCount,
        cityCount,
      );
    }

    if (forceReseed && (provinceCount > 0 || cityCount > 0)) {
      strapi.log.info(
        "⟳ FORCE_RESEED enabled. Clearing existing data (provinces=%d cities=%d)...",
        provinceCount,
        cityCount,
      );
      // Clear existing data for re-seeding
      await strapi.db.query("api::shipping-city.shipping-city").deleteMany();
      await strapi.db.query("api::shipping-province.shipping-province").deleteMany();
      if (shouldSeedShippings) {
        strapi.log.info("⟳ Clearing existing shippings (count=%d)...", shippingCount);
        await strapi.db.query("api::shipping.shipping").deleteMany();
      }
      strapi.log.info("✓ Cleared existing provinces and cities");
    }

    const provinceIdMap = new Map<string, number>();
    let finalCityCount = cityCount;

    if (shouldSeedLocations) {
      const appRoot = strapi.dirs.app.root;
      const jsonPath = path.resolve(appRoot, "database/iran-cities.json");
      const sqlPath = path.resolve(appRoot, "database/iran_cities (for api document) (2).sql");

      strapi.log.info("🔍 Checking for seed files...");
      strapi.log.debug("  JSON path: %s", jsonPath);
      strapi.log.debug("  SQL path: %s", sqlPath);

      const [jsonExists, sqlExists] = await Promise.all([
        fs
          .access(jsonPath)
          .then(() => true)
          .catch(() => false),
        fs
          .access(sqlPath)
          .then(() => true)
          .catch(() => false),
      ]);

      if (!jsonExists) {
        strapi.log.error(
          "✗ Iran locations bootstrap FAILED - missing files (json: %s, sql: %s). App root: %s",
          "✗ MISSING",
          sqlExists ? "✓ found" : "✗ MISSING",
          appRoot,
        );
        return;
      }

      if (!sqlExists) {
        strapi.log.warn(
          "⚠️ iran_cities SQL not found at %s. Proceeding without province/city codes; Titles will still be seeded.",
          sqlPath,
        );
      }

      strapi.log.info("✓ Found seed files (JSON required, SQL optional), starting import...");

      const raw = await fs.readFile(jsonPath, "utf8");
      const payload: CityPayload[] = JSON.parse(raw);

      const provinceCodeMap = new Map<string, string>();
      const cityCodeMap = new Map<string, Map<string, string>>();
      if (sqlExists) {
        const sql = await fs.readFile(sqlPath, "utf8");
        const tupleRegex = /\('([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\)/g;
        let match;
        while ((match = tupleRegex.exec(sql))) {
          const provinceName = (match[1] || "").trim();
          const provinceCode = (match[2] || "").trim();
          const cityName = (match[3] || "").trim();
          const cityCode = (match[4] || "").trim();
          if (!provinceName || !provinceCode || !cityName || !cityCode) continue;
          provinceCodeMap.set(provinceName, provinceCode);
          if (!cityCodeMap.has(provinceName)) cityCodeMap.set(provinceName, new Map());
          cityCodeMap.get(provinceName)!.set(cityName, cityCode);
        }
      }

      // Insert provinces with codes
      for (const entry of payload) {
        const existing = await strapi.db.query("api::shipping-province.shipping-province").findOne({
          where: { Title: entry.province },
        });
        if (existing) {
          provinceIdMap.set(entry.province, existing.id);
          continue;
        }
        const created = await strapi.entityService.create("api::shipping-province.shipping-province", {
          data: {
            Title: entry.province,
            Code: provinceCodeMap.get(entry.province) || null,
          },
          fields: ["id"],
        }) as { id: number };
        provinceIdMap.set(entry.province, Number(created.id));
      }

      // Insert cities referencing provinces
      for (const entry of payload) {
        const provinceId = provinceIdMap.get(entry.province);
        if (!provinceId) continue;
        const cityCodes = cityCodeMap.get(entry.province) || new Map();
        for (const cityTitle of entry.cities) {
          const existing = await strapi.db.query("api::shipping-city.shipping-city").findOne({
            where: { Title: cityTitle, shipping_province: provinceId },
          });
          if (existing) continue;
          await strapi.entityService.create("api::shipping-city.shipping-city", {
            data: {
              Title: cityTitle,
              shipping_province: provinceId,
              Code: cityCodes.get(cityTitle) || null,
            },
          });
        }
      }

      finalCityCount = await strapi.db.query("api::shipping-city.shipping-city").count();
    } else {
      strapi.log.info("↷ Skipped province/city seed (already present and FORCE_RESEED not set)");
    }

    const golestanProvince = await strapi.db.query("api::shipping-province.shipping-province").findOne({
      where: { Title: "گلستان" },
    });
    const gorganCity = golestanProvince
      ? await strapi.db.query("api::shipping-city.shipping-city").findOne({
          where: { Title: "گرگان", shipping_province: golestanProvince.id },
        })
      : null;
    const shippingBackfillContext: ShippingBackfillContext = {
      golestanProvinceId: golestanProvince?.id,
      gorganCityId: gorganCity?.id,
    };

    const existingShippings = await strapi.db.query("api::shipping.shipping").findMany({
      select: [
        "id",
        "Title",
        "Code",
        "Description",
        "SortOrder",
        "EstimatedDeliveryText",
        "Rules",
      ],
    });
    const existingByTitle = new Map(
      (existingShippings || []).map((s: { Title?: string }) => [(s?.Title || "").trim(), s]),
    );

    let createdCount = 0;
    let updatedCount = 0;
    for (const seed of DEFAULT_SHIPPINGS) {
      const normalized = (seed.Title || "").trim();
      if (!normalized) continue;

      const defaults = getShippingDefaults(seed, shippingBackfillContext);
      const existing = existingByTitle.get(normalized) as any;
      if (!existing) {
        await strapi.entityService.create("api::shipping.shipping", {
          data: {
            Title: normalized,
            Price: seed.Price,
            IsActive: seed.IsActive ?? true,
            removedAt: null,
            Code: defaults.Code,
            SortOrder: defaults.SortOrder,
            Description: defaults.Description,
            EstimatedDeliveryText: defaults.EstimatedDeliveryText,
            Rules: defaults.Rules,
          },
        });
        createdCount += 1;
        continue;
      }

      const data: Record<string, unknown> = {};
      if (!existing.Code && defaults.Code) data.Code = defaults.Code;
      if (
        (existing.SortOrder === null || existing.SortOrder === undefined || Number(existing.SortOrder) === 0) &&
        defaults.SortOrder
      ) {
        data.SortOrder = defaults.SortOrder;
      }
      if (!existing.Description && defaults.Description) data.Description = defaults.Description;
      if (!existing.EstimatedDeliveryText && defaults.EstimatedDeliveryText) {
        data.EstimatedDeliveryText = defaults.EstimatedDeliveryText;
      }
      if ((!Array.isArray(existing.Rules) || existing.Rules.length === 0) && defaults.Rules.length > 0) {
        data.Rules = defaults.Rules;
      }

      if (Object.keys(data).length > 0) {
        await strapi.entityService.update("api::shipping.shipping", existing.id, { data });
        updatedCount += 1;
      }
    }
    strapi.log.info(
      "✓ Shipping methods ready: created=%d backfilled=%d",
      createdCount,
      updatedCount,
    );

    const totalProvinces = shouldSeedLocations ? provinceIdMap.size : provinceCount;
    strapi.log.info(
      "✓ SEEDING COMPLETE: provinces=%d, cities=%d, shippings=%d",
      totalProvinces,
      finalCityCount,
      await strapi.db.query("api::shipping.shipping").count(),
    );
  } catch (error) {
    strapi.log.error("✗ SEEDING FAILED: Iran locations bootstrap error:", error);
  }
}
