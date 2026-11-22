import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-11-21_listing_sort_order",
  "Add the listings.sort_order column, the place an operator drags a listing to. Every existing listing starts at 0, so the order every list shows is unchanged until an operator moves a listing.",
  {
    columns: { listings: ["sort_order"] },
  },
);
