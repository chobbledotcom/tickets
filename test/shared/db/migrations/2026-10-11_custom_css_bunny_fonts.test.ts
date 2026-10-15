/** The custom CSS Bunny fonts backfill: the stored stylesheet is scanned once,
 *  and the saved flag says whether the CSP must name fonts.bunny.net. */

import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, resultRows } from "#db/client.ts";
import customCssBunnyFontsMigration from "#db/migrations/2026-10-11_custom_css_bunny_fonts.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
} from "#db/migrations.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  appliedMigrationIds,
  buildMigrationContext,
  settingsValueOrNull,
} from "#test-utils/migrations.ts";

type SettingRow = { key: string; value: string };

const settingRows = async (): Promise<SettingRow[]> =>
  resultRows(
    await getDb().execute(
      "SELECT key, value FROM settings WHERE key LIKE 'custom_css%'",
    ),
  );

const insertCustomCss = async (value: string): Promise<void> => {
  await getDb().execute({
    args: [value],
    sql: "INSERT INTO settings (key, value) VALUES ('custom_css', ?)",
  });
};

describeWithEnv("custom css bunny fonts migration", { db: true }, () => {
  test("stores true for a stylesheet that imports Bunny's fonts", async () => {
    await insertCustomCss(
      "@import url(https://fonts.bunny.net/css?family=aleo);",
    );

    await customCssBunnyFontsMigration(buildMigrationContext()).up();

    expect(await settingRows()).toContainEqual({
      key: "custom_css_bunny_fonts",
      value: "true",
    });
  });

  test("stores false for a stylesheet without a Bunny reference", async () => {
    await insertCustomCss("body { color: red; }");

    await customCssBunnyFontsMigration(buildMigrationContext()).up();

    expect(await settingRows()).toContainEqual({
      key: "custom_css_bunny_fonts",
      value: "false",
    });
  });

  test("stores false for a lookalike host the detector refuses", async () => {
    await insertCustomCss("@import url(https://fonts.bunny.net.evil.com/css);");

    await customCssBunnyFontsMigration(buildMigrationContext()).up();

    expect(await settingRows()).toContainEqual({
      key: "custom_css_bunny_fonts",
      value: "false",
    });
  });

  test("writes nothing when no custom CSS is stored", async () => {
    await customCssBunnyFontsMigration(buildMigrationContext()).up();

    expect(await settingRows()).toEqual([]);
  });

  test("backfills on a site upgrading from the previous release", async () => {
    // Without the LATEST_UPDATE bump beside this migration, a site last
    // migrated at the previous release reads up to date and skips the scan.
    invalidateInitDbCache();
    await initDb();
    await getDb().execute({
      args: ["@import url(https://fonts.bunny.net/css?family=aleo);"],
      sql: "INSERT INTO settings (key, value) VALUES ('custom_css', ?)",
    });
    await getDb().execute({
      args: [
        "Pad the stored holiday dates the pre-2476 mapper wrote unpadded.",
      ],
      sql: "UPDATE settings SET value = ? WHERE key = 'latest_db_update'",
    });
    await getDb().execute({
      args: ["2026-10-11_custom_css_bunny_fonts"],
      sql: "DELETE FROM schema_migrations WHERE id = ?",
    });
    invalidateInitDbCache();

    await initDb();

    expect(await settingsValueOrNull("custom_css_bunny_fonts")).toBe("true");
    assertArrayIncludes((await appliedMigrationIds()) ?? [], [
      "2026-10-11_custom_css_bunny_fonts",
    ]);
    expect(await settingsValueOrNull("latest_db_update")).toBe(LATEST_UPDATE);
  });
});
