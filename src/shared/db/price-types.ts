/**
 * The price-dimension keys every `listing_prices` row carries. The
 * base-mirror sync and the group overrides both read these values from here,
 * so neither module has to import the other.
 */

export const PRICE_TYPE_BASE = "base";
export const PRICE_TYPE_DAY_COUNT = "day_count";
export const PRICE_TYPE_GROUP = "group";
export const PRICE_TYPE_GROUP_DAY = "group_day";
