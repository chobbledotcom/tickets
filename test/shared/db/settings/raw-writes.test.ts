import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { writeRawBatch } from "#shared/db/settings/raw-writes.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("writeRawBatch", { db: true }, () => {
  test("persists multiple settings in one batch and mirrors the cache", async () => {
    await writeRawBatch([
      [CONFIG_KEYS.SQUARE_LOCATION_ID, "loc_test"],
      [CONFIG_KEYS.SUMUP_MERCHANT_CODE, "mc_test"],
    ]);
    // The raw cache mirrors the committed batch.
    expect(settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID)).toBe(
      "loc_test",
    );
    expect(settings.getCachedRaw(CONFIG_KEYS.SUMUP_MERCHANT_CODE)).toBe(
      "mc_test",
    );
    // Reload from DB to confirm persistence.
    settings.invalidateCache();
    await settings.loadKeys([
      CONFIG_KEYS.SQUARE_LOCATION_ID,
      CONFIG_KEYS.SUMUP_MERCHANT_CODE,
    ]);
    expect(settings.square.locationId).toBe("loc_test");
    expect(settings.sumup.merchantCode).toBe("mc_test");
  });
});
