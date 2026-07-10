import { schemaMigration } from "./define.ts";

/**
 * Public listing attributes: reusable attribute names, reusable multiple-choice
 * options, and a listing-option link table for display and admin filtering.
 */
export default schemaMigration(
  "2026-07-09_listing_attributes",
  "Add listing attributes with reusable multiple-choice options.",
  {
    indexes: [
      "idx_attributes_sort_order",
      "idx_attribute_options_attribute",
      "idx_listing_attribute_options_pair",
      "idx_listing_attribute_options_option",
    ],
    newTables: ["attributes", "attribute_options", "listing_attribute_options"],
  },
);
