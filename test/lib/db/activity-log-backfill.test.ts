import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ENCRYPTION_PREFIX, encrypt } from "#shared/crypto/encryption.ts";
import { HYBRID_PREFIX } from "#shared/crypto/keys.ts";
import {
  backfillActivityLogBatch,
  maybeBackfillActivityLog,
} from "#shared/db/activity-log-backfill.ts";
import { getAllActivityLog, logActivity } from "#shared/db/activityLog.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso } from "#shared/now.ts";
import { describeWithEnv, withTestSession } from "#test-utils";

/** Insert a row encrypted with DB_ENCRYPTION_KEY (the pre-migration format). */
const insertLegacyRow = async (message: string): Promise<number> => {
  const result = await execute(
    "INSERT INTO activity_log (message, created, listing_id, attendee_id) VALUES (?, ?, NULL, NULL)",
    [await encrypt(message), nowIso()],
  );
  return Number(result.lastInsertRowid);
};

/** Raw (still-encrypted) stored message for a row. */
const rawMessage = async (id: number): Promise<string> =>
  (await queryOne<{ message: string }>(
    "SELECT message FROM activity_log WHERE id = ?",
    [id],
  ))!.message;

describeWithEnv("db > activity log backfill", { db: true }, () => {
  test("re-encrypts legacy rows to the owner key, preserving the plaintext", async () => {
    const id1 = await insertLegacyRow("legacy one");
    const id2 = await insertLegacyRow("legacy two");
    expect((await rawMessage(id1)).startsWith(ENCRYPTION_PREFIX)).toBe(true);

    const converted = await backfillActivityLogBatch(settings.publicKey);

    expect(converted).toBe(2);
    expect((await rawMessage(id1)).startsWith(HYBRID_PREFIX)).toBe(true);
    expect((await rawMessage(id2)).startsWith(HYBRID_PREFIX)).toBe(true);
    // Re-encrypted rows still read back as the original plaintext for an admin.
    const messages = (await withTestSession(() => getAllActivityLog())).map(
      (e) => e.message,
    );
    expect(messages).toContain("legacy one");
    expect(messages).toContain("legacy two");
  });

  test("leaves owner-key rows untouched", async () => {
    const legacyId = await insertLegacyRow("legacy");
    const owner = await logActivity("already owner-key");
    const ownerBefore = await rawMessage(owner.id);

    const converted = await backfillActivityLogBatch(settings.publicKey);

    expect(converted).toBe(1); // only the legacy row matched
    expect(await rawMessage(owner.id)).toBe(ownerBefore); // byte-for-byte
    expect((await rawMessage(legacyId)).startsWith(HYBRID_PREFIX)).toBe(true);
  });

  test("returns 0 when no legacy rows remain", async () => {
    await logActivity("owner-key only");
    expect(await backfillActivityLogBatch(settings.publicKey)).toBe(0);
  });

  test("scheduler converts a due batch and records the run timestamp", async () => {
    const id = await insertLegacyRow("convert me");

    await maybeBackfillActivityLog();

    expect((await rawMessage(id)).startsWith(HYBRID_PREFIX)).toBe(true);
    // Work may remain, so it is not marked done after a non-empty batch.
    expect(settings.activityLogBackfillDone).not.toBe("true");
    expect(Number(settings.lastActivityLogBackfill)).toBeGreaterThan(0);
  });

  test("scheduler marks itself done once nothing remains", async () => {
    await maybeBackfillActivityLog();

    expect(settings.activityLogBackfillDone).toBe("true");
  });

  test("scheduler is a no-op once done", async () => {
    await settings.update.activityLogBackfillDone("true");
    const id = await insertLegacyRow("should stay legacy");

    await maybeBackfillActivityLog();

    expect((await rawMessage(id)).startsWith(ENCRYPTION_PREFIX)).toBe(true);
  });

  test("scheduler is a no-op before a key pair is configured", async () => {
    const id = await insertLegacyRow("no key yet");
    settings.setForTest({ public_key: "" });

    await maybeBackfillActivityLog();

    expect((await rawMessage(id)).startsWith(ENCRYPTION_PREFIX)).toBe(true);
    expect(settings.activityLogBackfillDone).not.toBe("true");
  });

  test("scheduler skips when the interval has not elapsed", async () => {
    await settings.update.lastActivityLogBackfill(String(Date.now()));
    const id = await insertLegacyRow("too soon");

    await maybeBackfillActivityLog();

    expect((await rawMessage(id)).startsWith(ENCRYPTION_PREFIX)).toBe(true);
  });

  test("scheduler swallows a failing batch without marking done", async () => {
    // A corrupt env-key payload makes decrypt throw partway through the batch.
    await execute(
      "INSERT INTO activity_log (message, created, listing_id, attendee_id) VALUES (?, ?, NULL, NULL)",
      [`${ENCRYPTION_PREFIX}AAAA:BBBB`, nowIso()],
    );

    await maybeBackfillActivityLog(); // must not throw

    expect(settings.activityLogBackfillDone).not.toBe("true");
  });
});
