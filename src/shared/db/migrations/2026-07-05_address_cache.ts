import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-05_address_cache",
  "Create the address_cache table: encrypted address-lookup results keyed by " +
    "an HMAC blind index of the normalised search, expiring after " +
    "ADDRESS_CACHE_DAYS.",
  {
    indexes: ["idx_address_cache_search_index", "idx_address_cache_created"],
    newTables: ["address_cache"],
  },
);
