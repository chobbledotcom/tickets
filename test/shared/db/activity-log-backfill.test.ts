import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ENCRYPTION_PREFIX } from "#shared/crypto/encryption.ts";
import { HYBRID_PREFIX } from "#shared/crypto/keys.ts";
import {
  backfillActivityLogBatch,
  runActivityLogBackfill,
} from "#shared/db/activity-log-backfill.ts";
import { getAllActivityLog, logActivity } from "#shared/db/activityLog.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { MAINTENANCE_TASKS } from "#shared/maintenance/registry.ts";
import { maintenance } from "#shared/maintenance/runner.ts";
import { nowIso } from "#shared/now.ts";
import {
  insertLegacyActivity,
  rawActivityMessage,
} from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import { withTestSession } from "#test-utils/session.ts";

const captureBackfillLogs = async (
  operation: () => Promise<unknown>,
): Promise<string[]> => {
  setSuppressDebugLogs(false);
  const debugStub = stub(console, "debug");
  try {
    await operation();
    return debugStub.calls
      .map((call) => String(call.args[0]))
      .filter((line) => line.includes("[Backfill]"));
  } finally {
    debugStub.restore();
    setSuppressDebugLogs(null);
  }
};

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

  test("logs the exact number of converted rows", async () => {
    const logs = await captureBackfillLogs(async () => {
      await insertLegacyActivity("legacy");
      await runActivityLogBackfill(settings.publicKey);
    });

    expect(logs).toEqual(["[Backfill] activity_log: re-encrypted 1 rows"]);
  });

  test("does not log when no rows need conversion", async () => {
    const logs = await captureBackfillLogs(() =>
      runActivityLogBackfill(settings.publicKey),
    );

    expect(logs).toEqual([]);
  });

  test("returns the size of each remaining batch", async () => {
    expect(await runActivityLogBackfill(settings.publicKey)).toBe(0);
    await insertLegacyActivity("legacy");
    expect(await runActivityLogBackfill(settings.publicKey)).toBe(1);
    expect(await runActivityLogBackfill(settings.publicKey)).toBe(0);
  });

  test("runs the legacy backfill through the maintenance registry", async () => {
    const id = await insertLegacyActivity("registry legacy");

    await maintenance.run(MAINTENANCE_TASKS);

    expect((await rawActivityMessage(id)).startsWith(HYBRID_PREFIX)).toBe(true);
  });

  test("a completed task does not scan the activity log again", async () => {
    await maintenance.run(MAINTENANCE_TASKS);
    expect(
      await queryOne<{ checkpoint: string }>(
        "SELECT checkpoint FROM maintenance_tasks WHERE name = 'activity_log_backfill'",
      ),
    ).toEqual({ checkpoint: "complete" });
    await execute(
      "UPDATE maintenance_tasks SET next_run_at = 0 WHERE name = 'activity_log_backfill'",
    );
    const queries: string[] = [];
    const restore = recordQueries(queries);
    try {
      await maintenance.run(MAINTENANCE_TASKS);
    } finally {
      restore();
    }

    expect(
      queries.filter((sql) =>
        sql.includes("FROM activity_log WHERE message LIKE"),
      ),
    ).toEqual([]);
  });

  test("surfaces a corrupt legacy message to the task runner", async () => {
    await execute(
      "INSERT INTO activity_log (message, created, listing_id, attendee_id) VALUES (?, ?, NULL, NULL)",
      [`${ENCRYPTION_PREFIX}AAAA:BBBB`, nowIso()],
    );
    await expect(runActivityLogBackfill(settings.publicKey)).rejects.toThrow();
  });

  test("fails loudly when a raw activity row does not exist", async () => {
    await expect(rawActivityMessage(999_999)).rejects.toThrow(
      "Activity log entry not found: 999999",
    );
  });
});
