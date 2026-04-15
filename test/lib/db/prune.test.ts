/**
 * Tests for DB pruning (processed_payments, sessions, login_attempts)
 * and the maybeRunPrunes scheduler.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { hmacHash } from "#lib/crypto/hashing.ts";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import { getDb, insert } from "#lib/db/client.ts";
import {
  finalizeSession as finalizePaymentSession,
  reserveSession,
} from "#lib/db/processed-payments.ts";
import {
  maybeRunPrunes,
  pruneLoginAttempts,
  prunePayments,
  pruneSessions,
} from "#lib/db/prune.ts";
import { createSession, getAllSessions } from "#lib/db/sessions.ts";
import { settings } from "#lib/db/settings.ts";
import {
  PRUNE_INTERVAL_MS,
  PRUNE_LOGINS_RETENTION_MS,
  PRUNE_PAYMENTS_RETENTION_MS,
  PRUNE_SESSIONS_RETENTION_MS,
} from "#lib/limits.ts";
import { nowMs } from "#lib/now.ts";
import { createTestEvent, describeWithEnv } from "#test-utils";

/** Insert a finalized processed_payments row with a chosen processed_at. */
const insertFinalizedPayment = async (
  sessionId: string,
  processedAtIso: string,
): Promise<void> => {
  const event = await createTestEvent({ maxAttendees: 10 });
  const attendeeResult = await createAttendeeAtomic({
    bookings: [{ eventId: event.id }],
    email: `${sessionId}@example.com`,
    name: "Prune Test",
  });
  if (!attendeeResult.success) throw new Error("attendee create failed");
  await reserveSession(sessionId);
  await finalizePaymentSession(sessionId, attendeeResult.attendees[0]!.id);
  // Backdate processed_at
  await getDb().execute({
    args: [processedAtIso, sessionId],
    sql: "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
  });
};

describeWithEnv("db > prune", { db: true }, () => {
  describe("prunePayments", () => {
    test("deletes finalized payments older than retention window", async () => {
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_old", old);

      const deleted = await prunePayments();

      expect(deleted).toBe(1);
      const { rows } = await getDb().execute({
        args: ["sess_old"],
        sql: "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
      });
      expect(rows.length).toBe(0);
    });

    test("keeps finalized payments within retention window", async () => {
      const recent = new Date(nowMs() - 1000).toISOString();
      await insertFinalizedPayment("sess_recent", recent);

      const deleted = await prunePayments();

      expect(deleted).toBe(0);
      const { rows } = await getDb().execute({
        args: ["sess_recent"],
        sql: "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
      });
      expect(rows.length).toBe(1);
    });

    test("leaves unfinalized reservations alone regardless of age", async () => {
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await getDb().execute(
        insert("processed_payments", {
          attendee_id: null,
          payment_session_id: "sess_unfinalized",
          processed_at: old,
        }),
      );

      const deleted = await prunePayments();

      expect(deleted).toBe(0);
      const { rows } = await getDb().execute({
        args: ["sess_unfinalized"],
        sql: "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
      });
      expect(rows.length).toBe(1);
    });
  });

  describe("pruneSessions", () => {
    test("deletes sessions whose expiry is past the retention window", async () => {
      const expiredMs = nowMs() - PRUNE_SESSIONS_RETENTION_MS - 60_000;
      await createSession("stale-tok", "csrf", expiredMs, null, 1);

      const deleted = await pruneSessions();

      expect(deleted).toBe(1);
      const remaining = await getAllSessions();
      expect(remaining.map((s) => s.csrf_token)).not.toContain("csrf");
    });

    test("keeps active sessions (future expiry)", async () => {
      await createSession(
        "active-tok",
        "csrf-active",
        nowMs() + 60 * 60 * 1000,
        null,
        1,
      );

      const deleted = await pruneSessions();

      expect(deleted).toBe(0);
      const remaining = await getAllSessions();
      expect(remaining.map((s) => s.csrf_token)).toContain("csrf-active");
    });

    test("keeps recently-expired sessions within retention grace", async () => {
      // Expired 1 second ago — within retention window
      await createSession(
        "fresh-expired",
        "csrf-fresh-expired",
        nowMs() - 1_000,
        null,
        1,
      );

      const deleted = await pruneSessions();

      expect(deleted).toBe(0);
    });
  });

  describe("pruneLoginAttempts", () => {
    test("deletes rows with lockouts past retention window", async () => {
      const ipHash = await hmacHash("1.2.3.4");
      const oldLockout = nowMs() - PRUNE_LOGINS_RETENTION_MS - 60_000;
      await getDb().execute({
        args: [ipHash, 5, oldLockout],
        sql: "INSERT INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
      });

      const deleted = await pruneLoginAttempts();

      expect(deleted).toBe(1);
    });

    test("keeps counter-only rows (locked_until IS NULL)", async () => {
      const ipHash = await hmacHash("5.6.7.8");
      await getDb().execute({
        args: [ipHash, 2],
        sql: "INSERT INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, NULL)",
      });

      const deleted = await pruneLoginAttempts();

      expect(deleted).toBe(0);
      const { rows } = await getDb().execute({
        args: [ipHash],
        sql: "SELECT ip FROM login_attempts WHERE ip = ?",
      });
      expect(rows.length).toBe(1);
    });

    test("keeps rows with currently-active lockouts", async () => {
      const ipHash = await hmacHash("9.10.11.12");
      const futureLockout = nowMs() + 60_000;
      await getDb().execute({
        args: [ipHash, 5, futureLockout],
        sql: "INSERT INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
      });

      const deleted = await pruneLoginAttempts();

      expect(deleted).toBe(0);
    });
  });

  describe("maybeRunPrunes scheduler", () => {
    test("records last-pruned timestamp after running", async () => {
      await settings.update.lastPrunedPayments("");
      await settings.update.lastPrunedSessions("");
      await settings.update.lastPrunedLogins("");
      await settings.loadAll();

      const before = nowMs();
      await maybeRunPrunes();

      const paymentsTs = Number.parseInt(settings.lastPrunedPayments, 10);
      const sessionsTs = Number.parseInt(settings.lastPrunedSessions, 10);
      const loginsTs = Number.parseInt(settings.lastPrunedLogins, 10);
      expect(paymentsTs).toBeGreaterThanOrEqual(before);
      expect(sessionsTs).toBeGreaterThanOrEqual(before);
      expect(loginsTs).toBeGreaterThanOrEqual(before);
    });

    test("skips tasks not yet due since last run", async () => {
      // Simulate "just ran" for all three
      const justRan = String(nowMs());
      await settings.update.lastPrunedPayments(justRan);
      await settings.update.lastPrunedSessions(justRan);
      await settings.update.lastPrunedLogins(justRan);
      await settings.loadAll();

      // Insert an old finalized payment that WOULD be pruned if the task ran
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_skip", old);

      await maybeRunPrunes();

      // Row should still exist — task was skipped
      const { rows } = await getDb().execute({
        args: ["sess_skip"],
        sql: "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
      });
      expect(rows.length).toBe(1);
    });

    test("runs tasks when last-run is older than the interval", async () => {
      // Insert first, then backdate last_pruned. Doing it the other way round
      // races with the request-handler fire-and-forget prune triggered by the
      // HTTP call inside insertFinalizedPayment.
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_due", old);

      const oldRun = String(nowMs() - PRUNE_INTERVAL_MS - 60_000);
      await settings.update.lastPrunedPayments(oldRun);
      await settings.update.lastPrunedSessions(oldRun);
      await settings.update.lastPrunedLogins(oldRun);

      await maybeRunPrunes();

      const { rows } = await getDb().execute({
        args: ["sess_due"],
        sql: "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
      });
      expect(rows.length).toBe(0);
    });

    test("one task's failure does not block the others", async () => {
      // Empty last-run timestamps → all three due
      await settings.update.lastPrunedPayments("");
      await settings.update.lastPrunedSessions("");
      await settings.update.lastPrunedLogins("");
      await settings.loadAll();

      // Drop sessions table so pruneSessions fails
      await getDb().execute("DROP TABLE sessions");

      await maybeRunPrunes();

      // Payments and logins timestamps should still be updated
      expect(settings.lastPrunedPayments).not.toBe("");
      expect(settings.lastPrunedLogins).not.toBe("");
      // (afterEach -> resetDb will clean up the dropped sessions table)
    });

    test("treats an invalid last-pruned value as never-run", async () => {
      // Write a garbage value, then call maybeRunPrunes — it should run.
      await settings.update.lastPrunedPayments("not-a-number");
      await settings.update.lastPrunedSessions("");
      await settings.update.lastPrunedLogins("");
      await settings.loadAll();

      const before = nowMs();
      await maybeRunPrunes();

      const ts = Number.parseInt(settings.lastPrunedPayments, 10);
      expect(ts).toBeGreaterThanOrEqual(before);
    });

    test("multiple concurrent calls are idempotent", async () => {
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_concurrent", old);

      // Reset timestamps AFTER the insert (which makes HTTP calls that race
      // with the fire-and-forget prune scheduler in the request handler).
      await settings.update.lastPrunedPayments("");
      await settings.update.lastPrunedSessions("");
      await settings.update.lastPrunedLogins("");

      await Promise.all([maybeRunPrunes(), maybeRunPrunes(), maybeRunPrunes()]);

      // Row is deleted exactly once; concurrent calls do not error
      const { rows } = await getDb().execute({
        args: ["sess_concurrent"],
        sql: "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
      });
      expect(rows.length).toBe(0);
    });
  });

  describe("interval arithmetic (FakeTime)", () => {
    test("task becomes due exactly PRUNE_INTERVAL_MS after its last run", async () => {
      const start = 1_700_000_000_000;
      const time = new FakeTime(start);
      try {
        await settings.update.lastPrunedPayments(String(start));
        await settings.update.lastPrunedSessions(String(start));
        await settings.update.lastPrunedLogins(String(start));
        await settings.loadAll();

        // Insert something prunable (dated far in the past)
        const old = new Date(
          start - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
        ).toISOString();
        await insertFinalizedPayment("sess_interval", old);

        // Just before interval elapses — not yet due
        time.tick(PRUNE_INTERVAL_MS - 1);
        await maybeRunPrunes();
        const mid = await getDb().execute({
          args: ["sess_interval"],
          sql: "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
        });
        expect(mid.rows.length).toBe(1);

        // Interval elapses — now due
        time.tick(1);
        await maybeRunPrunes();
        const after = await getDb().execute({
          args: ["sess_interval"],
          sql: "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
        });
        expect(after.rows.length).toBe(0);
      } finally {
        time.restore();
      }
    });
  });
});
