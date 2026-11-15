import { sql, sqlLiteral } from "#db/sql.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { schemaMigration } from "./define.ts";

/** The feature key this release adds to every stored feature setting. */
const EXTERNAL_SOURCES_FEATURE = "externalSources";

const FEATURE_PATH = sqlLiteral(`$.${EXTERNAL_SOURCES_FEATURE}`);

export default schemaMigration(
  "2026-11-03_external_sources",
  "Add the external sources directory, its links to records, and the feature that shows it",
  {
    indexes: [
      "idx_external_source_links_lookup",
      "idx_external_source_links_external",
      "idx_external_source_links_target",
    ],
    newTables: ["external_sources", "external_source_links"],
  },
  async ({ getDb }) => {
    // A stored setting written before this release carries no value for the new
    // feature. The strict reader refuses an incomplete setting, so add the key
    // as off before any read.
    await getDb().execute(
      sql`UPDATE settings
               SET value = json_set(value, ${FEATURE_PATH}, json('false'))
             WHERE key = ${CONFIG_KEYS.ENABLED_FEATURES}
               AND json_valid(value)
               AND json_type(value, ${FEATURE_PATH}) IS NULL`,
    );
  },
);
