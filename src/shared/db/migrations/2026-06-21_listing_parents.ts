import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-21_listing_parents",
  "Add listing_parents table holding child->parent edges between listings, so a parent listing can require the buyer to choose one of its children during booking",
  {
    indexes: ["idx_listing_parents_pair", "idx_listing_parents_child"],
    newTables: ["listing_parents"],
  },
);
