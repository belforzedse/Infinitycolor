"use strict";

function boundedInteger(value, { name, defaultValue, min = 1, max }) {
  const candidate = value === undefined || value === null || value === "" ? defaultValue : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received ${value}`);
  }
  return candidate;
}

const IMPORT_PROFILES = ["default", "fast"];

/**
 * Resolve the opt-in high-throughput profile. Unset (or "default") preserves
 * every existing production default untouched; "fast" only changes which
 * *default* a concurrency knob falls back to when its own env var is unset —
 * an explicit `IMPORT_CONCURRENCY_*` / `WOOCOMMERCE_SYNC_FRIDAY_*` value
 * always wins over the profile.
 */
function resolveImportProfile(env = process.env) {
  const raw = String(env.WOOCOMMERCE_IMPORT_PROFILE || "default").trim().toLowerCase() || "default";
  if (!IMPORT_PROFILES.includes(raw)) {
    throw new Error(`WOOCOMMERCE_IMPORT_PROFILE must be one of ${IMPORT_PROFILES.join(", ")}; received "${raw}"`);
  }
  return raw;
}

/** Pick the fallback default for a concurrency knob under the active profile. */
function profileDefault(profile, { default: defaultValue, fast: fastValue }) {
  return profile === "fast" ? fastValue : defaultValue;
}

async function mapPoolOrdered(items, concurrency, mapper, { canStart = null } = {}) {
  const values = Array.from(items);
  const results = new Array(values.length);
  let cursor = 0;
  let failure = null;
  const worker = async () => {
    while (true) {
      if (failure) return;
      if (canStart) await canStart();
      const index = cursor;
      if (index >= values.length) return;
      cursor += 1;
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        failure = error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  if (failure) throw failure;
  return results;
}

function toPullableIterator(source) {
  if (source && typeof source[Symbol.asyncIterator] === "function") return source[Symbol.asyncIterator]();
  if (source && typeof source[Symbol.iterator] === "function") {
    const it = source[Symbol.iterator]();
    return { next: () => Promise.resolve(it.next()) };
  }
  throw new Error("mapPoolAsync: source is not iterable");
}

/**
 * Bounded worker pool over a *pull* source — a plain array, an async
 * generator (e.g. a paginated API iterator), or any iterable/async-iterable.
 *
 * Unlike `mapPoolOrdered`, this never materializes the source with
 * `Array.from` first (which silently drains an async generator to `[]`).
 * Each worker pulls its next item from a single serialized `next()` chain, so
 * the underlying iterator is only ever advanced one call at a time even
 * though the resulting work runs with up to `concurrency` items in flight.
 * Item order/results are not tracked — this is for side-effecting work
 * (e.g. syncing a product) where only "did every item get processed, and did
 * the first hard failure abort the rest" matters.
 */
async function mapPoolAsync(source, concurrency, mapper, { canStart = null } = {}) {
  const iterator = toPullableIterator(source);
  let chain = Promise.resolve();
  const pullNext = () => {
    const result = chain.then(() => iterator.next());
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  let index = 0;
  let failure = null;
  const worker = async () => {
    while (!failure) {
      if (canStart) await canStart();
      const { value, done } = await pullNext();
      if (done) return;
      const currentIndex = index++;
      try {
        await mapper(value, currentIndex);
      } catch (error) {
        failure = error;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (failure) throw failure;
}

module.exports = {
  boundedInteger,
  mapPoolOrdered,
  mapPoolAsync,
  resolveImportProfile,
  profileDefault,
};
