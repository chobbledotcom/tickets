import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ENCRYPTION_PREFIX } from "#shared/crypto/encryption.ts";
import { HYBRID_PREFIX } from "#shared/crypto/keys.ts";
import {
  backfillActivityLogBatch,
  hasLegacyActivityLog,
  runActivityLogBackfill,
} from "#shared/db/activity-log-backfill.ts";
import { getAllActivityLog, logActivity } from "#shared/db/activityLog.ts";
import { execute } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { MAINTENANCE_TASKS } from "#shared/maintenance/registry.ts";
import { runMaintenance } from "#shared/maintenance/runner.ts";
import { nowIso } from "#shared/now.ts";
import {
  insertLegacyActivity,
  rawActivityMessage,
} from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withTestSession } from "#test-utils/session.ts";

describeWithEnv("db > activity log backfill", { db: true }, () => {
  test("re-encrypts legacy rows to the owner key, preserving the plaintext", async () => {
    const id1 = await insertLegacyActivity("legacy one");
    const id2 = await insertLegacyActivity("legacy two");
    expect((await rawActivityMessage(id1)).startsWith(ENCRYPTION_PREFIX)).toBe(
      true,
    );

    const converted = await backfillActivityLogBatch(settings.publicKey);

    expect(converted).toBe(2);
    expect((await rawActivityMessage(id1)).startsWith(HYBRID_PREFIX)).toBe(
      true,
    );
    expect((await rawActivityMessage(id2)).startsWith(HYBRID_PREFIX)).toBe(
      true,
    );
    // Re-encrypted rows still read back as the original plaintext for an admin.
    const messages = (await withTestSession(() => getAllActivityLog())).map(
      (e) => e.message,
    );
    expect(messages).toContain("legacy one");
    expect(messages).toContain("legacy two");
  });

  test("leaves owner-key rows untouched", async () => {
    const legacyId = await insertLegacyActivity("legacy");
    const owner = await logActivity("already owner-key");
    const ownerBefore = await rawActivityMessage(owner.id);

    const converted = await backfillActivityLogBatch(settings.publicKey);

    expect(converted).toBe(1); // only the legacy row matched
    expect(await rawActivityMessage(owner.id)).toBe(ownerBefore); // byte-for-byte
    expect((await rawActivityMessage(legacyId)).startsWith(HYBRID_PREFIX)).toBe(
      true,
    );
  });

  test("writes each re-encrypted message back to its own row (by id)", async () => {
    const id1 = await insertLegacyActivity("first plaintext");
    const id2 = await insertLegacyActivity("second plaintext");

    await backfillActivityLogBatch(settings.publicKey);

    // Keyed by row id: a crossed id in the batched UPDATEs would swap these.
    const byId = new Map(
      (await withTestSession(() => getAllActivityLog())).map((e) => [
        e.id,
        e.message,
      ]),
    );
    expect(byId.get(id1)).toBe("first plaintext");
    expect(byId.get(id2)).toBe("second plaintext");
  });

  test("returns 0 when no legacy rows remain", async () => {
    await logActivity("owner-key only");
    expect(await backfillActivityLogBatch(settings.publicKey)).toBe(0);
  });

  test("reports whether legacy work remains", async () => {
    expect(await hasLegacyActivityLog()).toBe(false);
    await insertLegacyActivity("legacy");
    expect(await hasLegacyActivityLog()).toBe(true);
    await runActivityLogBackfill(settings.publicKey);
    expect(await hasLegacyActivityLog()).toBe(false);
  });

  test("runs the legacy backfill through the maintenance registry", async () => {
    const id = await insertLegacyActivity("registry legacy");

    await runMaintenance(MAINTENANCE_TASKS);

    expect((await rawActivityMessage(id)).startsWith(HYBRID_PREFIX)).toBe(true);
  });

  test("surfaces a corrupt legacy message to the task runner", async () => {
    await execute(
      "INSERT INTO activity_log (message, created, listing_id, attendee_id) VALUES (?, ?, NULL, NULL)",
      [`${ENCRYPTION_PREFIX}AAAA:BBBB`, nowIso()],
    );
    await expect(runActivityLogBackfill(settings.publicKey)).rejects.toThrow();
  });
});
