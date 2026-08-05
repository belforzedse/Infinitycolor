'use strict';

/**
 * Restores Anipo province/city codes from the provider data that was lost when
 * the backend was moved into the monorepo. The earlier SQL asset was ignored by
 * apps/backend/.gitignore, and the old migration returned successfully when it
 * could not find that file.
 *
 * This migration is deliberately non-destructive: it only fills blank codes and
 * never deletes/re-seeds rows, so existing customer address relation IDs remain
 * stable.
 */

const fs = require('node:fs');
const path = require('node:path');

const ANIPO_LOCATION_MIGRATION_LOCK_KEY = 827453101;

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u200c\s\-ـ()]/g, '');
}

function loadCodeMaps() {
  const assetPath = path.resolve(
    __dirname,
    '..',
    'anipo-location-codes.json',
  );
  if (!fs.existsSync(assetPath)) {
    throw new Error(`ANIPO_LOCATION_CODE_ASSET_MISSING:${assetPath}`);
  }
  const payload = JSON.parse(fs.readFileSync(assetPath, 'utf8'));
  const provinceCodes = new Map();
  const cityCodes = new Map();
  for (const entry of payload || []) {
    const provinceKey = normalizeTitle(entry && entry.province);
    const provinceCode = String((entry && entry.code) || '').trim();
    if (!provinceKey || !provinceCode) continue;
    provinceCodes.set(provinceKey, provinceCode);
    const codes = new Map();
    for (const [title, code] of Object.entries((entry && entry.cities) || {})) {
      const cityKey = normalizeTitle(title);
      const cityCode = String(code || '').trim();
      if (cityKey && cityCode) codes.set(cityKey, cityCode);
    }
    cityCodes.set(provinceKey, codes);
  }
  if (provinceCodes.size !== 31) {
    throw new Error(
      `ANIPO_LOCATION_CODE_ASSET_INCOMPLETE:expected=31 actual=${provinceCodes.size}`,
    );
  }
  return { provinceCodes, cityCodes };
}

module.exports = {
  async up(knex) {
    await knex.raw('SELECT pg_advisory_xact_lock(?)', [
      ANIPO_LOCATION_MIGRATION_LOCK_KEY,
    ]);

    const requiredTables = [
      'shipping_provinces',
      'shipping_cities',
      'shipping_cities_shipping_province_links',
    ];
    for (const table of requiredTables) {
      if (!(await knex.schema.hasTable(table))) return;
    }
    if (
      !(await knex.schema.hasColumn('shipping_provinces', 'code')) ||
      !(await knex.schema.hasColumn('shipping_cities', 'code'))
    ) {
      throw new Error('ANIPO_LOCATION_CODE_COLUMNS_MISSING');
    }

    const maps = loadCodeMaps();
    const provinces = await knex('shipping_provinces').select(
      'id',
      'title',
      'code',
    );
    let provinceUpdates = 0;
    for (const province of provinces) {
      if (String(province.code || '').trim()) continue;
      const code = maps.provinceCodes.get(normalizeTitle(province.title));
      if (!code) continue;
      await knex('shipping_provinces')
        .where({ id: province.id })
        .update({ code });
      provinceUpdates += 1;
    }

    const cities = await knex('shipping_cities as city')
      .leftJoin(
        'shipping_cities_shipping_province_links as link',
        'link.shipping_city_id',
        'city.id',
      )
      .leftJoin(
        'shipping_provinces as province',
        'province.id',
        'link.shipping_province_id',
      )
      .select(
        'city.id',
        'city.title',
        'city.code',
        'province.title as province_title',
      );
    let cityUpdates = 0;
    for (const city of cities) {
      if (String(city.code || '').trim()) continue;
      const provinceKey = normalizeTitle(city.province_title);
      const code = maps.cityCodes
        .get(provinceKey)
        ?.get(normalizeTitle(city.title));
      if (!code) continue;
      await knex('shipping_cities').where({ id: city.id }).update({ code });
      cityUpdates += 1;
    }

    console.info(
      `Anipo location code backfill complete: provinces=${provinceUpdates} cities=${cityUpdates}`,
    );
  },

  async down() {
    // Intentionally irreversible: existing non-empty codes are indistinguishable
    // from values this migration restored, and clearing either would break Anipo.
  },
};
