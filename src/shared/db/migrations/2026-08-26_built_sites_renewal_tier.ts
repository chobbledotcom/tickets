import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-08-26_built_sites_renewal_tier",
  "Add a renewal_tier_listing_id column to built_sites naming the one renewal tier listing a site renews on, so an operator can see and change a site's tier and the /renew picker offers only that tier",
  {
    columns: { built_sites: ["renewal_tier_listing_id"] },
  },
);
