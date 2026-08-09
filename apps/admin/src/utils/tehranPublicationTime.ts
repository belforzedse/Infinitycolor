export const TEHRAN_TIMEZONE = "Asia/Tehran";

export type TehranWallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function partsForInstant(value: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TEHRAN_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function instantToTehranWallTime(value: string | Date): TehranWallTime {
  const parsed = value instanceof Date ? value : new Date(value);
  const parts = partsForInstant(parsed);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function tehranWallTimeToUtcIso(value: TehranWallTime): string {
  const desired = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    0,
  );
  let utcMs = desired;
  for (let i = 0; i < 3; i += 1) {
    const parts = partsForInstant(new Date(utcMs));
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second || 0),
    );
    utcMs += desired - represented;
  }

  const resolved = new Date(utcMs);
  const roundTrip = instantToTehranWallTime(resolved);
  if (
    roundTrip.year !== value.year ||
    roundTrip.month !== value.month ||
    roundTrip.day !== value.day ||
    roundTrip.hour !== value.hour ||
    roundTrip.minute !== value.minute
  ) {
    throw new Error("INVALID_TEHRAN_WALL_TIME");
  }
  return resolved.toISOString();
}

/** A local Date carrying Tehran wall-clock components for uncontrolled pickers. */
export function tehranPickerDate(value: string | Date): Date {
  const parts = instantToTehranWallTime(value);
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
}

export function pickerToTehranIso(date: Date, hour: number, minute: number): string {
  return tehranWallTimeToUtcIso({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour,
    minute,
  });
}

export function formatTehranPublication(value: string | Date): string {
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: TEHRAN_TIMEZONE,
    dateStyle: "long",
    timeStyle: "short",
    hour12: false,
  }).format(value instanceof Date ? value : new Date(value));
}
