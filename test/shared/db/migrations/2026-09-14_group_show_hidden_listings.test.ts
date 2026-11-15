import groupShowHiddenListings from "#db/migrations/2026-09-14_group_show_hidden_listings.ts";
import { sql } from "#db/sql.ts";
import { describeColumnMigration } from "#test-utils/migration-column-suite.ts";

// DEFAULT 1 is the compatibility promise: an upgraded site's groups keep
// offering their hidden members until each group opts out.
describeColumnMigration({
  column: "show_hidden_listings",
  declared: {
    description:
      "Add groups.show_hidden_listings. A regular group's public booking page " +
      "offers the member listings it marks Hidden only while its own flag says " +
      "so. The column defaults to 1, so every stored group keeps offering its " +
      "hidden members until an operator unticks the group's box. Package groups " +
      "ignore the flag: a bundle is one product built from every member.",
    id: "2026-09-14_group_show_hidden_listings",
  },
  defaultValue: 1,
  insertRow: sql`INSERT INTO groups (id, slug, slug_index, name) VALUES (9091, 'hidden-flag-group', 'hidden-flag-index', 'Hidden Flag Group')`,
  migration: groupShowHiddenListings,
  name: "db > migrations > group show hidden listings",
  rowId: 9091,
  table: "groups",
  title: "adds the flag so a stored group keeps showing its hidden members",
});
