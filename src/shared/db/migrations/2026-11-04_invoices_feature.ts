import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { bareSchemaMigration } from "./define.ts";

/** The enabled-feature setting gained an Invoices key. A site that already
 *  sent invoices keeps the menu for them, and every other site starts with it
 *  hidden like the other optional features. */
export default bareSchemaMigration(
  "2026-11-04_invoices_feature",
  "Add the Invoices feature switch to the stored enabled-feature setting.",
  async ({ getDb }) => {
    await getDb().execute(`
      UPDATE settings
      SET value = json_set(
        value,
        '$.invoices',
        json(IIF(EXISTS (SELECT 1 FROM invoices AS invoice), 'true', 'false'))
      )
      WHERE key = '${CONFIG_KEYS.ENABLED_FEATURES}'
        AND json_type(value, '$.invoices') IS NULL
    `);
  },
);
