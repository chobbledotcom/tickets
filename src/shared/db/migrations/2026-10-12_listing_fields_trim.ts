import {
  executeBatchWithoutCacheInvalidation,
  queryAllPrimary,
} from "#db/client.ts";
import { storedListingFields } from "#shared/listing-fields.ts";
import { bareSchemaMigration } from "./define.ts";

/** Rewrite every listing's contact fields as the parser's own read of the
 *  string (see `storedListingFields`), so the badge SQL can compare whole
 *  tokens. Rows already in the stored form stay untouched. */
export default bareSchemaMigration(
  "2026-10-12_listing_fields_trim",
  "Store every listing's contact fields as trimmed, comma-joined tokens.",
  async () => {
    const rows = await queryAllPrimary<{ fields: string; id: number }>({
      args: [],
      sql: "SELECT id, fields FROM listings",
    });
    const updates = rows.flatMap((row) => {
      const fields = storedListingFields(row.fields);
      return fields === row.fields
        ? []
        : [
            {
              args: [fields, row.id],
              sql: "UPDATE listings SET fields = ? WHERE id = ?",
            },
          ];
    });
    await executeBatchWithoutCacheInvalidation(updates);
  },
);
