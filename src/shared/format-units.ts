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
  const format = UNIT_FORMATTERS[unit];
  return format ? format(value) : `${value} ${unit}`;
};
