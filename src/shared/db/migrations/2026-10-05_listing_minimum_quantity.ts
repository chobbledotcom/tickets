import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-10-05_listing_minimum_quantity",
  "Add the listings.minimum_quantity column, defaulting every existing listing to 1 so today's choice set (none, or 1 up to the per-order maximum) is unchanged until an owner raises it.",
  {
    columns: { listings: ["minimum_quantity"] },
  },
);
