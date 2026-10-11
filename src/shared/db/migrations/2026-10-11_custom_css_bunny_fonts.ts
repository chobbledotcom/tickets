/** Scan the stored custom CSS once and store whether it uses Bunny's fonts,
 *  so the CSP builder reads a saved flag instead of scanning on every
 *  response. Installs that predate the flag keep the CSP they already had. */

import {
  executeBatchWithoutCacheInvalidation,
  queryAllPrimary,
} from "#db/client.ts";
import { settingUpsert } from "#db/settings/raw-writes.ts";
import { cssUsesBunnyFonts } from "#routes/public/bunny-fonts.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { bareSchemaMigration } from "./define.ts";

export default bareSchemaMigration(
  "2026-10-11_custom_css_bunny_fonts",
  "Store whether the custom CSS uses Bunny's fonts, scanned from the saved CSS.",
  async () => {
    const rows = await queryAllPrimary<{ value: string }>({
      args: [CONFIG_KEYS.CUSTOM_CSS],
      sql: "SELECT value FROM settings WHERE key = ?",
    });
    await executeBatchWithoutCacheInvalidation(
      rows.map((row) =>
        settingUpsert(
          CONFIG_KEYS.CUSTOM_CSS_BUNNY_FONTS,
          cssUsesBunnyFonts(row.value) ? "true" : "false",
        ),
      ),
    );
  },
);
