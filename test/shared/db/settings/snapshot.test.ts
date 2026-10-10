/** Direct tests for db/settings/snapshot.ts — the snapshot's stored defaults. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > settings > snapshot", { db: true }, () => {
  describe("the stored defaults", () => {
    test("getCurrencyCodeFromDb returns GBP by default", () => {
      expect(settings.currency).toBe("GBP");
    });

    test("getCountryFromDb returns GB when no country is stored", async () => {
      await getDb().execute("DELETE FROM settings");
      settings.invalidateCache();
      expect(settings.country).toBe("GB");
    });
  });
});
