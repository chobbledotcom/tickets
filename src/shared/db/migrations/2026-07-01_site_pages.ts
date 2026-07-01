import { schemaMigration } from "./define.ts";

/**
 * User-created content pages (pages.md). Adds two tables:
 *
 * - `site_pages` — one row per page. All free-text columns (slug, name,
 *   meta_title, meta_description, content) are stored encrypted; `slug_index`
 *   is the plaintext HMAC blind index for lookups, and `sort_order` positions
 *   the page among root-level pages.
 * - `site_page_items` — ordered membership edges keyed on
 *   `(page_id, item_type, item_id)`, where an item is a listing, group, or
 *   another page. The single-parent invariant for `page` items is enforced in
 *   application code (the schema machinery can't express a partial-unique
 *   index — see pages.md N3).
 */
export default schemaMigration(
  "2026-07-01_site_pages",
  "Add site_pages and site_page_items tables backing user-created content pages.",
  {
    indexes: [
      "idx_site_pages_slug_index",
      "idx_site_page_items_page",
      "idx_site_page_items_key",
      "idx_site_page_items_child_page",
    ],
    newTables: ["site_pages", "site_page_items"],
  },
);
