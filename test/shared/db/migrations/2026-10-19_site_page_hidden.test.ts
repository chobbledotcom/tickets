import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch, getDb } from "#db/client.ts";
import sitePageHidden from "#db/migrations/2026-10-19_site_page_hidden.ts";
import {
  applySchemaChanges,
  getExistingColumns,
  syncIndexes,
} from "#db/migrations/schema-sync.ts";
import { initDb, invalidateInitDbCache, SCHEMA_HASH } from "#db/migrations.ts";
import { getSitePageById } from "#db/site-pages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import {
  appliedMigrationIds,
  buildMigrationContext,
  settingsValueOrNull,
} from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const migration = () => sitePageHidden(context);

describeWithEnv("db > migrations > site page hidden", { db: true }, () => {
  test("adds the flag so a stored page stays visible until an operator hides it", async () => {
    await getDb().execute(
      "INSERT INTO site_pages (id, slug, slug_index, name) VALUES (9091, 'hidden-flag-page', 'hidden-flag-index', 'Hidden Flag Page')",
    );
    await getDb().execute("ALTER TABLE site_pages DROP COLUMN hidden");

    await migration().up();

    expect((await getExistingColumns("site_pages")).has("hidden")).toBe(true);
    const result = await getDb().execute(
      "SELECT hidden FROM site_pages WHERE id = 9091",
    );
    // DEFAULT 0 is the compatibility promise: an upgraded site's pages all
    // stay in the menus and the sitemap until each page opts out.
    expect(Number(result.rows[0]?.hidden)).toBe(0);
  });

  test("upgrades an existing site through the registered migration without changing its pages", async () => {
    await initDb();
    const page = await createTestSitePage("upgrade-page", {
      content: "Saved page text.",
      metaDescription: "Saved description.",
      metaTitle: "Saved title",
      name: "Saved page",
    });
    await executeBatch([
      { args: [], sql: "ALTER TABLE site_pages DROP COLUMN hidden" },
      {
        args: ["1qv5isp"],
        sql: "UPDATE settings SET value = ? WHERE key = 'db_schema_hash'",
      },
      {
        args: ["2026-10-19_site_page_hidden"],
        sql: "DELETE FROM schema_migrations WHERE id = ?",
      },
    ]);
    invalidateInitDbCache();

    await initDb();

    expect(await getSitePageById(page.id)).toEqual(page);
    assertArrayIncludes(await appliedMigrationIds(), [
      "2026-10-19_site_page_hidden",
    ]);
    expect(await settingsValueOrNull("db_schema_hash")).toBe(SCHEMA_HASH);
  });
});
