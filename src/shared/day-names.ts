/**
 * Weekday name data — deliberately dependency-free so early-loaded, self-
 * contained modules (like the catalog transfer schema) can read the day
 * names without pulling in the timezone/settings-loading graph.
 */

/** Day name lookup from Date.getUTCDay() index (Sunday=0) */
export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const [sunday, ...mondayFirst] = DAY_NAMES;

/** Valid day names for bookable_days (Monday-first for display) */
export const VALID_DAY_NAMES = [...mondayFirst, sunday] as const;
