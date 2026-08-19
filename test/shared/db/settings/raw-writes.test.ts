import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
import {
  deleteRaw,
  writeOrDelete,
  writeRaw,
  writeRawBatch,
} from "#db/settings/raw-writes.ts";
import { CONFIG_KEYS, settings } from "#db/settings.ts";
import {
  assertSettingsReadsDeclared,
  runWithSettingsAudit,
} from "#db/settings-audit.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { statementSql } from "#test-utils/record-queries.ts";

const expectSquareLocationAbsent = async (): Promise<void> => {
  expect(settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID)).toBeNull();
  settings.invalidateCache();
  await settings.loadKeys([CONFIG_KEYS.SQUARE_LOCATION_ID]);
  expect(settings.square.locationId).toBe("");
};

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

  test("throws on an empty batch", async () => {
    await expect(writeRawBatch([])).rejects.toThrow(
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

  test("registers audit-loaded keys", async () => {
    await runWithSettingsAudit(async () => {
      await writeRaw(CONFIG_KEYS.SQUARE_LOCATION_ID, "audit_one");
      await writeRawBatch([[CONFIG_KEYS.SUMUP_MERCHANT_CODE, "audit_two"]]);
      settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID);
      settings.getCachedRaw(CONFIG_KEYS.SUMUP_MERCHANT_CODE);
      assertSettingsReadsDeclared("test");
    });
  });

  test("writeOrDelete persists an empty value by deleting the row", async () => {
    await writeRaw(CONFIG_KEYS.SQUARE_LOCATION_ID, "del_target");
    await writeOrDelete(CONFIG_KEYS.SQUARE_LOCATION_ID, "");
    await expectSquareLocationAbsent();
  });

  test("written keys are not refilled later in the same request", async () => {
    settings.invalidateCache();
    await runWithRequestCache(async () => {
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);
      await writeRaw(CONFIG_KEYS.SQUARE_LOCATION_ID, "same_request");
      await writeRawBatch([
        [CONFIG_KEYS.SUMUP_MERCHANT_CODE, "same_request_batch"],
      ]);

      const db = getDb();
      const execute = db.execute.bind(db);
      using reads = stub(db, "execute", (statement) => execute(statement));
      await settings.loadKeys([
        CONFIG_KEYS.SQUARE_LOCATION_ID,
        CONFIG_KEYS.SUMUP_MERCHANT_CODE,
      ]);

      expect(
        reads.calls.filter(({ args }) =>
          statementSql(args[0]).includes("SELECT key, value FROM settings"),
        ),
      ).toEqual([]);
      expect(settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID)).toBe(
        "same_request",
      );
      expect(settings.getCachedRaw(CONFIG_KEYS.SUMUP_MERCHANT_CODE)).toBe(
        "same_request_batch",
      );
    });
  });
});

describeWithEnv("deleteRaw", { db: true }, () => {
  test("deletes a setting and clears it from the cache", async () => {
    await writeRaw(CONFIG_KEYS.SQUARE_LOCATION_ID, "loc_del");
    expect(settings.getCachedRaw(CONFIG_KEYS.SQUARE_LOCATION_ID)).toBe(
      "loc_del",
    );
    await deleteRaw(CONFIG_KEYS.SQUARE_LOCATION_ID);
    await expectSquareLocationAbsent();
  });
});

describeWithEnv("settings write audit", { db: true }, () => {
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
