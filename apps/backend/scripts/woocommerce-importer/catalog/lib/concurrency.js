"use strict";

function boundedInteger(value, { name, defaultValue, min = 1, max }) {
  const candidate = value === undefined || value === null || value === "" ? defaultValue : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received ${value}`);
  }
  return candidate;
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

module.exports = { boundedInteger, mapPoolOrdered };
