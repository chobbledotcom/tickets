import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import sitePageHidden from "#db/migrations/2026-10-19_site_page_hidden.ts";
import {
  applySchemaChanges,
  getExistingColumns,
  syncIndexes,
} from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

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

  test("declares every object it owns", () => {
    // Anything left off this list is never verified, so a partial upgrade
    // would record itself as applied.
    expect(migration().id).toBe("2026-10-19_site_page_hidden");
    expect(migration().requires).toEqual({
      columns: { site_pages: ["hidden"] },
    });
    expect(migration().description).toBe(
      "Add site_pages.hidden. The page editor's Hidden checkbox keeps a page off " +
        "the public menus and the sitemap; the page's direct link keeps serving " +
        "and answers with a noindex robots tag. The column defaults to 0, so " +
        "every stored page stays visible until an operator ticks the box.",
    );
  });
});
