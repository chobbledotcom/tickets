import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  deleteRaw,
  executeSettingsBatchReturningValue,
  writeOrDelete,
  writeRaw,
  writeRawBatch,
} from "#shared/db/settings/raw-writes.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import {
  assertSettingsReadsDeclared,
  runWithSettingsAudit,
} from "#shared/db/settings-audit.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("writeRawBatch", { db: true }, () => {
  test("persists multiple settings in one batch and mirrors the cache", async () => {
    await writeRawBatch([
      [CONFIG_KEYS.SQUARE_LOCATION_ID, "loc_test"],
      [CONFIG_KEYS.SUMUP_MERCHANT_CODE, "mc_test"],
    ]);
    expect(settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID)).toBe(
      "loc_test",
    );
    expect(settings.getCachedRaw(CONFIG_KEYS.SUMUP_MERCHANT_CODE)).toBe(
      "mc_test",
    );
    settings.invalidateCache();
    await settings.loadKeys([
      CONFIG_KEYS.SQUARE_LOCATION_ID,
      CONFIG_KEYS.SUMUP_MERCHANT_CODE,
    ]);
    expect(settings.square.locationId).toBe("loc_test");
    expect(settings.sumup.merchantCode).toBe("mc_test");
  });

  test("throws on an empty batch", () => {
    expect(writeRawBatch([])).rejects.toThrow(
      "Cannot write an empty settings batch",
    );
  });

  test("marks every key loaded so getCachedRaw reads succeed", async () => {
    await writeRawBatch([
      [CONFIG_KEYS.SQUARE_LOCATION_ID, "loc_a"],
      [CONFIG_KEYS.SUMUP_MERCHANT_CODE, "mc_a"],
    ]);
    expect(settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID)).toBe("loc_a");
    expect(settings.getCachedRaw(CONFIG_KEYS.SUMUP_MERCHANT_CODE)).toBe("mc_a");
  });
});

describeWithEnv("writeRaw", { db: true }, () => {
  test("persists a setting and mirrors the cache", async () => {
    await writeRaw(CONFIG_KEYS.SQUARE_LOCATION_ID, "loc_single");
    expect(settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID)).toBe(
      "loc_single",
    );
    settings.invalidateCache();
    await settings.loadKeys([CONFIG_KEYS.SQUARE_LOCATION_ID]);
    expect(settings.square.locationId).toBe("loc_single");
  });

  test("registers audit-loaded keys; writeOrDelete empties via deleteRaw", async () => {
    await runWithSettingsAudit(async () => {
      await writeRaw(CONFIG_KEYS.SQUARE_LOCATION_ID, "audit_one");
      await writeRawBatch([[CONFIG_KEYS.SUMUP_MERCHANT_CODE, "audit_two"]]);
      settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID);
      settings.getCachedRaw(CONFIG_KEYS.SUMUP_MERCHANT_CODE);
      assertSettingsReadsDeclared("test");
    });
    await writeRaw(CONFIG_KEYS.SQUARE_LOCATION_ID, "del_target");
    await writeOrDelete(CONFIG_KEYS.SQUARE_LOCATION_ID, "");
    expect(settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID)).toBeNull();
  });
});

describeWithEnv("deleteRaw", { db: true }, () => {
  test("deletes a setting and clears it from the cache", async () => {
    await writeRaw(CONFIG_KEYS.SQUARE_LOCATION_ID, "loc_del");
    expect(settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID)).toBe(
      "loc_del",
    );
    await deleteRaw(CONFIG_KEYS.SQUARE_LOCATION_ID);
    expect(settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID)).toBeNull();
    settings.invalidateCache();
    await settings.loadKeys([CONFIG_KEYS.SQUARE_LOCATION_ID]);
    expect(settings.square.locationId).toBe("");
  });
});

describeWithEnv("executeSettingsBatchReturningValue", { db: true }, () => {
  test("returns the RETURNING value from a real INSERT", async () => {
    const value = await executeSettingsBatchReturningValue(
      {
        args: [],
        sql:
          "INSERT OR REPLACE INTO settings (key, value) " +
          "VALUES ('test_returning_key', 'stripe') RETURNING value",
      },
      [],
    );
    expect(value).toBe("stripe");
  });

  test("writeRaw marks the key loaded so snap() audit passes", async () => {
    await runWithSettingsAudit(async () => {
      await writeRaw(CONFIG_KEYS.SQUARE_LOCATION_ID, "audit_snap");
      settings.square.locationId;
      assertSettingsReadsDeclared("snap-audit");
    });
  });

  test("writeRawBatch marks every key loaded so snap() audit passes", async () => {
    await runWithSettingsAudit(async () => {
      await writeRawBatch([
        [CONFIG_KEYS.SQUARE_LOCATION_ID, "audit_batch"],
        [CONFIG_KEYS.SUMUP_MERCHANT_CODE, "audit_batch_mc"],
      ]);
      settings.square.locationId;
      settings.sumup.merchantCode;
      assertSettingsReadsDeclared("batch-audit");
    });
  });
});
