/**
 * The price-dimension keys every `listing_prices` row carries. A leaf module
 * of pure values, so the base-mirror sync and the group overrides can both
 * reach them without joining each other's import rings.
 */

export const PRICE_TYPE_BASE = "base";
export const PRICE_TYPE_DAY_COUNT = "day_count";
export const PRICE_TYPE_GROUP = "group";
export const PRICE_TYPE_GROUP_DAY = "group_day";
