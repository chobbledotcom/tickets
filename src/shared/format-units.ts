/** Sizes and durations in the words a person reads: bytes as B/KB/MB, and
 * milliseconds or seconds in the biggest rung they reach. */

/** One rung of a size ladder: how many base units it holds, and what to call
 * it. Ladders are written biggest first. */
type Rung = readonly [size: number, suffix: string];

/** Build a formatter that names a number in the biggest rung it reaches,
 * rounded to a whole number of them, and falls back to `baseSuffix` below the
 * smallest rung. Every human-readable size and duration below is one of these. */
const laddered =
  (rungs: readonly Rung[], baseSuffix: string): ((value: number) => string) =>
  (value: number): string => {
    for (const [size, suffix] of rungs) {
      if (value >= size) return `${Math.round(value / size)}${suffix}`;
    }
    return `${value}${baseSuffix}`;
  };

/** Format bytes as a human-readable size string */
export const formatBytes = laddered(
  [
    [1024 * 1024, "MB"],
    [1024, "KB"],
  ],
  "B",
);

/** Format milliseconds as a human-readable duration string */
export const formatMs = laddered(
  [
    [60 * 60 * 1000, "h"],
    [60 * 1000, "min"],
    [1000, "s"],
  ],
  "ms",
);

/** Format seconds as a human-readable duration string */
export const formatSeconds = laddered(
  [
    [24 * 60 * 60, "d"],
    [60 * 60, "h"],
    [60, "min"],
  ],
  "s",
);

/** The units that carry their own ladder. Every other unit is a plain count,
 * so it reads as "<value> <unit>". */
const UNIT_FORMATTERS: Record<string, (value: number) => string> = {
  bytes: formatBytes,
  ms: formatMs,
  seconds: formatSeconds,
};

/** Format a limit value with its unit into a human-readable string */
export const formatLimitValue = (value: number, unit: string): string => {
  const format = Object.hasOwn(UNIT_FORMATTERS, unit)
    ? UNIT_FORMATTERS[unit]
    : undefined;
  return format ? format(value) : `${value} ${unit}`;
};

/** A length in seconds as the words a person reads: whole hours in hours,
 * whole minutes in minutes, anything shorter in seconds. */
export const durationWords = (seconds: number): string => {
  const hours = seconds / 3600;
  if (Number.isInteger(hours)) {
    return hours === 1 ? "an hour" : `${hours} hours`;
  }
  const minutes = seconds / 60;
  if (Number.isInteger(minutes)) {
    return minutes === 1 ? "a minute" : `${minutes} minutes`;
  }
  return `${seconds} seconds`;
};

/** A count with the thing it counts, plural only when the count is not one:
 * `3 rows`, `1 row`, `0 tables`. */
export const countLabel = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
