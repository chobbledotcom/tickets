import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch } from "#db/client.ts";
import sitePageHidden from "#db/migrations/2026-10-19_site_page_hidden.ts";
import { initDb, invalidateInitDbCache, SCHEMA_HASH } from "#db/migrations.ts";
import { records } from "#db/record-table.ts";
import { sql } from "#db/sql.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { describeColumnMigration } from "#test-utils/migration-column-suite.ts";
import {
  appliedMigrationIds,
  settingsValueOrNull,
} from "#test-utils/migrations.ts";

// DEFAULT 0 is the compatibility promise: an upgraded site's pages all stay in
// the menus and the sitemap until each page opts out.
describeColumnMigration({
  column: "hidden",
  defaultValue: 0,
  extraTests: () => {
    test("upgrades an existing site through the registered migration without changing its pages", async () => {
      await initDb();
      const page = await createTestSitePage("upgrade-page", {
        content: "Saved page text.",
        metaDescription: "Saved description.",
        metaTitle: "Saved title",
        name: "Saved page",
      });
      await executeBatch([
        sql`ALTER TABLE site_pages DROP COLUMN hidden`,
        sql`UPDATE settings SET value = ${"1qv5isp"} WHERE key = 'db_schema_hash'`,
        sql`DELETE FROM schema_migrations WHERE id = ${"2026-10-19_site_page_hidden"}`,
      ]);
      invalidateInitDbCache();

      await initDb();

      expect(await records.site_pages.find(page.id)).toEqual(page);
      assertArrayIncludes(await appliedMigrationIds(), [
        "2026-10-19_site_page_hidden",
      ]);
      expect(await settingsValueOrNull("db_schema_hash")).toBe(SCHEMA_HASH);
    });
  },
  insertRow: sql`INSERT INTO site_pages (id, slug, slug_index, name) VALUES (9091, 'hidden-flag-page', 'hidden-flag-index', 'Hidden Flag Page')`,
  migration: sitePageHidden,
  name: "db > migrations > site page hidden",
  rowId: 9091,
  table: "site_pages",
  title:
    "adds the flag so a stored page stays visible until an operator hides it",
});
