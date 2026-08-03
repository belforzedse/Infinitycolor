import type { Strapi } from "@strapi/strapi";
import fs from "node:fs/promises";
import path from "node:path";

type CityPayload = { province: string; cities: string[] };
type AnipoLocationCodePayload = {
  province: string;
  code: string;
  cities: Record<string, string>;
};

export function normalizeIranLocationTitle(value: unknown): string {
  return String(value || "")
    .normalize("NFC")
    .trim()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200c\s\-ـ()]/g, "");
}

export function buildAnipoLocationCodeMaps(payload: AnipoLocationCodePayload[]) {
  const provinceCodes = new Map<string, string>();
  const cityCodes = new Map<string, Map<string, string>>();

  for (const entry of payload || []) {
    const provinceKey = normalizeIranLocationTitle(entry?.province);
    const provinceCode = String(entry?.code || "").trim();
    if (!provinceKey || !provinceCode) continue;

    provinceCodes.set(provinceKey, provinceCode);
    const codes = new Map<string, string>();
    for (const [title, code] of Object.entries(entry?.cities || {})) {
      const cityKey = normalizeIranLocationTitle(title);
      const cityCode = String(code || "").trim();
      if (cityKey && cityCode) codes.set(cityKey, cityCode);
    }
    cityCodes.set(provinceKey, codes);
  }

  return { provinceCodes, cityCodes };
}

async function backfillAnipoLocationCodes(
  strapi: Strapi,
  maps: ReturnType<typeof buildAnipoLocationCodeMaps>,
) {
  const provinceQuery = strapi.db.query(
    "api::shipping-province.shipping-province",
  );
  const cityQuery = strapi.db.query("api::shipping-city.shipping-city");
  const provinces: any[] = await provinceQuery.findMany({
    select: ["id", "Title", "Code"],
  } as any);
  const provinceTitleById = new Map<number, string>();
  let provinceUpdates = 0;

  for (const province of provinces || []) {
    provinceTitleById.set(Number(province.id), String(province.Title || ""));
    if (String(province.Code || "").trim()) continue;
    const code = maps.provinceCodes.get(
      normalizeIranLocationTitle(province.Title),
    );
    if (!code) continue;
    await provinceQuery.update({
      where: { id: province.id },
      data: { Code: code },
    } as any);
    provinceUpdates += 1;
  }

  const cities: any[] = await cityQuery.findMany({
    select: ["id", "Title", "Code"],
    populate: { shipping_province: true },
  } as any);
  let cityUpdates = 0;
  let missingCityMappings = 0;
  for (const city of cities || []) {
    if (String(city.Code || "").trim()) continue;
    const provinceId = Number(
      city?.shipping_province?.id ?? city?.shipping_province,
    );
    const provinceTitle =
      city?.shipping_province?.Title || provinceTitleById.get(provinceId) || "";
    const cityMap = maps.cityCodes.get(
      normalizeIranLocationTitle(provinceTitle),
    );
    const code = cityMap?.get(normalizeIranLocationTitle(city.Title));
    if (!code) {
      missingCityMappings += 1;
      continue;
    }
    await cityQuery.update({
      where: { id: city.id },
      data: { Code: code },
    } as any);
    cityUpdates += 1;
  }

  strapi.log.info(
    "✓ Anipo location codes ready: provinces backfilled=%d cities backfilled=%d",
    provinceUpdates,
    cityUpdates,
  );
  if (missingCityMappings > 0) {
    strapi.log.warn(
      "⚠️ Anipo has no exact provider code for %d existing city/county titles; barcode issuance remains available because it uses province code plus city title",
      missingCityMappings,
    );
  }
}

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
    const appRoot = strapi.dirs.app.root;
    const locationsPath = path.resolve(appRoot, "database/iran-cities.json");
    const anipoCodesPath = path.resolve(
      appRoot,
      "database/anipo-location-codes.json",
    );
    const [rawLocations, rawAnipoCodes] = await Promise.all([
      fs.readFile(locationsPath, "utf8"),
      fs.readFile(anipoCodesPath, "utf8"),
    ]);
    const payload: CityPayload[] = JSON.parse(rawLocations);
    const anipoCodePayload: AnipoLocationCodePayload[] =
      JSON.parse(rawAnipoCodes);
    const anipoCodeMaps = buildAnipoLocationCodeMaps(anipoCodePayload);
    if (anipoCodeMaps.provinceCodes.size !== payload.length) {
      throw new Error(
        `ANIPO_LOCATION_CODE_DATA_INCOMPLETE: expected ${payload.length} provinces, found ${anipoCodeMaps.provinceCodes.size}`,
      );
    }

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
      strapi.log.info(
        "✓ Found Iran locations and Anipo code data, starting import...",
      );

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
            Code:
              anipoCodeMaps.provinceCodes.get(
                normalizeIranLocationTitle(entry.province),
              ) || null,
          },
          fields: ["id"],
        }) as { id: number };
        provinceIdMap.set(entry.province, Number(created.id));
      }

      // Insert cities referencing provinces
      for (const entry of payload) {
        const provinceId = provinceIdMap.get(entry.province);
        if (!provinceId) continue;
        const cityCodes =
          anipoCodeMaps.cityCodes.get(
            normalizeIranLocationTitle(entry.province),
          ) || new Map();
        for (const cityTitle of entry.cities) {
          const existing = await strapi.db.query("api::shipping-city.shipping-city").findOne({
            where: { Title: cityTitle, shipping_province: provinceId },
          });
          if (existing) continue;
          await strapi.entityService.create("api::shipping-city.shipping-city", {
            data: {
              Title: cityTitle,
              shipping_province: provinceId,
              Code:
                cityCodes.get(normalizeIranLocationTitle(cityTitle)) || null,
            },
          });
        }
      }

      finalCityCount = await strapi.db.query("api::shipping-city.shipping-city").count();
    } else {
      strapi.log.info("↷ Skipped province/city seed (already present and FORCE_RESEED not set)");
    }

    // Existing installations used to skip location data as soon as row counts
    // were non-zero. Backfill missing provider codes independently so upgrades
    // repair data without deleting addresses or changing relation IDs.
    await backfillAnipoLocationCodes(strapi, anipoCodeMaps);

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
