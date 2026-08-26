/**
 * Branch cover for the feature routes, beside the story
 * `@story:settings.turning-features-on-and-off`.
 *
 * The story owns the owner's journey through the rendered pages: the list and
 * its statuses, each feature explaining itself, the choice being kept, Site
 * publishing the public site, and a feature in use offering no choice.
 *
 * These own what a browser cannot reach or a story cannot be the only cover
 * of: who may open each address, a slug the site has no feature for, a send
 * only a crafted POST can make, the settings cache, what is left in the
 * settings table, and the races and rollback around disabling Logistics.
 */

import type { InStatement } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { setAdminFeatureEnabled } from "#db/admin-features.ts";
import { getDb, queryOne } from "#db/client.ts";
import { CONFIG_KEYS, settings } from "#db/settings.ts";
import { parseEnabledFeatures } from "#shared/admin-features.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { statementSql } from "#test-utils/record-queries.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import {
  describeAdminSettings,
  saveAModifier,
  storedFeatureEnabled,
  withFeatureWriteFailure,
} from "#test-utils/settings.ts";

const expectFeatureSaved = async (
  slug: string,
  enabled: boolean,
  message: string,
): Promise<void> => {
  const path = `/admin/features/${slug}`;
  const { response } = await adminFormPost(path, {
    enabled: String(enabled),
  });
  await expectFlashRedirect(path, message)(response);
};

const IN_USE_HELP =
  "This feature is in use. Remove its saved items before you disable it.";

describeAdminSettings(() => {
  testRequiresAuth("/admin/features/modifiers");
  testRequiresAuth("/admin/features/modifiers", {
    body: { enabled: "true" },
    method: "POST",
  });

  test("shows the feature table last on the settings page", async () => {
    const html = await (await adminGet("/admin/settings")).text();
    expect(html.indexOf("Features")).toBeGreaterThan(
      html.indexOf("Calendar feeds"),
    );
  });

  test("returns 404 for an unknown feature", async () => {
    expectStatus(404)(await adminGet("/admin/features/unknown"));
  });

  test("rejects a missing enabled choice", async () => {
    // The page always renders one radio already picked, so only a crafted send
    // can arrive with no choice at all.
    const { response } = await adminFormPost("/admin/features/money", {});
    expect(response.status).toBe(302);
    expectFlash(response, "Choose whether to enable this feature.", false);
    expect(settings.features.money).toBe(false);
  });

  test("caches the feature setting it just wrote", async () => {
    await settings.update.listingDefaults({
      hidden: true,
      usesLogistics: true,
    });
    await expectFeatureSaved("logistics", true, "Logistics enabled.");
    expect(settings.listingDefaults.usesLogistics).toBe(true);

    await expectFeatureSaved("logistics", false, "Logistics disabled.");
    expect(settings.listingDefaults).toEqual({ hidden: true });
    expect(settings.features.logistics).toBe(false);
    const cached = settings.getCachedRaw(CONFIG_KEYS.ENABLED_FEATURES);
    if (cached === null) throw new Error("Feature setting was not cached");
    expect(parseEnabledFeatures(cached).logistics).toBe(false);
  });

  test("disables Logistics without creating a listing default", async () => {
    await expectFeatureSaved("logistics", false, "Logistics disabled.");
    expect(settings.listingDefaults.usesLogistics).toBeUndefined();
    expect(
      await queryOne("SELECT value FROM settings WHERE key = ?", [
        CONFIG_KEYS.LISTING_DEFAULTS,
      ]),
    ).toBeNull();
    expect(await storedFeatureEnabled("logistics")).toBe(false);
  });

  test("keeps listing defaults that do not use Logistics", async () => {
    await settings.update.listingDefaults({ hidden: true });
    await setAdminFeatureEnabled("logistics", true);

    await expectFeatureSaved("logistics", false, "Logistics disabled.");

    expect(settings.listingDefaults).toEqual({ hidden: true });
  });

  test("keeps a concurrent listing-default change while disabling Logistics", async () => {
    await settings.update.listingDefaults({
      hidden: false,
      usesLogistics: true,
    });
    await setAdminFeatureEnabled("logistics", true);
    const db = getDb();
    const originalBatch = db.batch.bind(db);
    let changePending = true;
    const batchStub = stub(db, "batch", async (statements, mode) => {
      if (changePending && JSON.stringify(statements).includes("$.logistics")) {
        changePending = false;
        await settings.update.listingDefaults({
          hidden: true,
          minimumDaysBefore: 5,
          usesLogistics: true,
        });
      }
      return originalBatch(statements, mode);
    });
    try {
      await expectFeatureSaved("logistics", false, "Logistics disabled.");
    } finally {
      batchStub.restore();
    }
    settings.invalidateCache();
    await settings.loadKeys([CONFIG_KEYS.LISTING_DEFAULTS]);
    expect(settings.listingDefaults).toEqual({
      hidden: true,
      minimumDaysBefore: 5,
    });
  });

  test("fails when listing defaults keep changing during Logistics disable", async () => {
    await settings.update.listingDefaults({ usesLogistics: true });
    await setAdminFeatureEnabled("logistics", true);
    const db = getDb();
    const originalBatch = db.batch.bind(db);
    let attempts = 0;
    const batchStub = stub(db, "batch", async (statements, mode) => {
      if (JSON.stringify(statements).includes("$.logistics")) {
        attempts += 1;
        await settings.update.listingDefaults({
          hidden: attempts % 2 === 0,
          usesLogistics: true,
        });
      }
      return originalBatch(statements, mode);
    });
    try {
      await expect(setAdminFeatureEnabled("logistics", false)).rejects.toThrow(
        /^Listing defaults changed too often to disable Logistics$/,
      );
    } finally {
      batchStub.restore();
    }
    expect(attempts).toBe(8);
  });

  test("keeps the Logistics default when new use rejects disabling", async () => {
    await settings.update.listingDefaults({ usesLogistics: true });
    await setAdminFeatureEnabled("logistics", true);
    const db = getDb();
    const originalExecute = db.execute.bind(db);
    const originalBatch = db.batch.bind(db);
    let inserted = false;
    const insertUse = async (): Promise<void> => {
      inserted = true;
      await originalExecute(
        "INSERT INTO logistics_agents (name) VALUES ('New delivery team')",
      );
    };
    const executeStub = stub(db, "execute", async (statement: InStatement) => {
      const result = await originalExecute(statement);
      const sql = statementSql(statement);
      if (
        !inserted &&
        sql.startsWith("UPDATE settings SET value = ? WHERE key = ?")
      ) {
        await insertUse();
      }
      return result;
    });
    const batchStub = stub(db, "batch", async (statements, mode) => {
      if (!inserted && JSON.stringify(statements).includes("$.logistics")) {
        await insertUse();
      }
      return originalBatch(statements, mode);
    });
    try {
      const { response } = await adminFormPost("/admin/features/logistics", {
        enabled: "false",
      });
      expectFlash(response, IN_USE_HELP, false);
    } finally {
      executeStub.restore();
      batchStub.restore();
    }
    settings.invalidateCache();
    await settings.loadKeys([
      CONFIG_KEYS.ENABLED_FEATURES,
      CONFIG_KEYS.LISTING_DEFAULTS,
    ]);
    expect(settings.listingDefaults.usesLogistics).toBe(true);
    expect(await storedFeatureEnabled("logistics")).toBe(true);
  });

  test("rolls back Logistics disable when its feature write fails", async () => {
    await settings.update.listingDefaults({ usesLogistics: true });
    await setAdminFeatureEnabled("logistics", true);

    await withFeatureWriteFailure(() =>
      expect(setAdminFeatureEnabled("logistics", false)).rejects.toThrow(
        "feature enable failed",
      ),
    );

    settings.invalidateCache();
    await settings.loadKeys([
      CONFIG_KEYS.ENABLED_FEATURES,
      CONFIG_KEYS.LISTING_DEFAULTS,
    ]);
    expect(settings.features.logistics).toBe(true);
    expect(settings.listingDefaults.usesLogistics).toBe(true);
  });

  test("refuses a crafted send that would disable a feature in use", async () => {
    // The page offers no form at all while a feature is in use, so this send
    // is one no browser could have made. The story owns what that page shows.
    await saveAModifier();
    await setAdminFeatureEnabled("modifiers", true);

    const { response } = await adminFormPost("/admin/features/modifiers", {
      enabled: "false",
    });
    expect(response.status).toBe(302);
    expectFlash(response, IN_USE_HELP, false);
    expect(await storedFeatureEnabled("modifiers")).toBe(true);
  });

  test("keeps a feature enabled when its first record appears during disable", async () => {
    await setAdminFeatureEnabled("modifiers", true);
    const db = getDb();
    const originalExecute = db.execute.bind(db);
    let inserted = false;
    const executeStub = stub(db, "execute", async (statement: InStatement) => {
      const result = await originalExecute(statement);
      const sql = statementSql(statement);
      if (!inserted && sql.includes("SELECT json_object")) {
        inserted = true;
        await saveAModifier();
      }
      return result;
    });
    try {
      const { response } = await adminFormPost("/admin/features/modifiers", {
        enabled: "false",
      });
      expectFlash(response, IN_USE_HELP, false);
    } finally {
      executeStub.restore();
    }
    expect(await storedFeatureEnabled("modifiers")).toBe(true);
  });
});
