/** The migration that adds the redirects table. */

import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-11-23_redirects",
  "Add redirects. An operator maps a missing page to a new address, and a visitor to the missing page gets a permanent redirect. A row keeps the page as a blind index and as sealed text, and keeps the new address as sealed text.",
  {
    indexes: ["idx_redirects_from_index"],
    newTables: ["redirects"],
  },
);
