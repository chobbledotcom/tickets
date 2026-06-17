/**
 * Tests for DB pruning (processed_payments, sessions, login_attempts)
 * and the maybeRunPrunes scheduler.
 *
 * Rows are inserted directly via SQL (no HTTP) so the fire-and-forget
 * prune in the request handler can't race with test setup.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { getDb, insert } from "#shared/db/client.ts";
import {
  maybeRunPrunes,
  pruneContacts,
  pruneLoginAttempts,
  prunePayments,
  pruneSessions,
  pruneSumupCheckouts,
  pruneTokenAttempts,
} from "#shared/db/prune.ts";
import { createSession, getAllSessions } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  PRUNE_CONTACTS_RETENTION_MS,
  PRUNE_INTERVAL_MS,
  PRUNE_LOGINS_RETENTION_MS,
  PRUNE_PAYMENTS_RETENTION_MS,
  PRUNE_SESSIONS_RETENTION_MS,
  PRUNE_SUMUP_RETENTION_MS,
  PRUNE_TOKENS_RETENTION_MS,
} from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils";

/**
 * Insert a finalized processed_payments row via direct SQL.
 * FKs are not enforced (see migrations.ts), so attendee_id can be any
 * non-null integer — the prune query only filters on `attendee_id IS NOT NULL`.
 */
const insertFinalizedPayment = async (
  sessionId: string,
  processedAtIso: string,
): Promise<void> => {
  await getDb().execute(
    insert("processed_payments", {
      attendee_id: 1,
      payment_session_id: sessionId,
      processed_at: processedAtIso,
      ticket_tokens: "",
    }),
  );
};

/** Insert an unfinalized (attendee_id NULL) processed_payments row. */
const insertUnfinalizedPayment = async (
  sessionId: string,
  processedAtIso: string,
): Promise<void> => {
  await getDb().execute(
    insert("processed_payments", {
      attendee_id: null,
      payment_session_id: sessionId,
      processed_at: processedAtIso,
    }),
  );
};

/** Insert a terminal-failure row (attendee_id NULL but failure_data recorded). */
const insertFailedPayment = async (
  sessionId: string,
  processedAtIso: string,
): Promise<void> => {
  await getDb().execute(
    insert("processed_payments", {
      attendee_id: null,
      failure_data: '{"error":"sold out","status":409,"refunded":true}',
      payment_session_id: sessionId,
      processed_at: processedAtIso,
    }),
  );
};

/** Insert a sumup_checkouts row with the given creation timestamp.
 * Prune filters only on created_at, so index/key/blob contents are inert. */
const insertSumupCheckout = async (
  referenceIndex: string,
  createdAtIso: string,
): Promise<void> => {
  await getDb().execute(
    insert("sumup_checkouts", {
      created_at: createdAtIso,
      metadata: "ciphertext",
      reference_index: referenceIndex,
      wrapped_key: "wk",
    }),
  );
};

/** Is a sumup_checkouts row with this reference index still in the DB? */
const sumupCheckoutExists = async (
  referenceIndex: string,
): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [referenceIndex],
    sql: "SELECT 1 FROM sumup_checkouts WHERE reference_index = ?",
  });
  return rows.length > 0;
};

/** Insert a login_attempts row with the given lockout (or NULL). */
const insertLoginAttempt = async (
  ipPlain: string,
  attempts: number,
  lockedUntil: number | null,
): Promise<string> => {
  const ipHash = await hmacHash(ipPlain);
  await getDb().execute({
    args: [ipHash, attempts, lockedUntil],
    sql: "INSERT INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
  });
  return ipHash;
};

/** Insert a token_attempts row with the given lockout and last_attempt timestamp. */
const insertTokenAttempt = async (
  ipPlain: string,
  lockedUntil: number | null,
  lastAttempt: number,
): Promise<string> => {
  const ipHash = await hmacHash(ipPlain);
  await getDb().execute({
    args: [ipHash, "[]", lockedUntil, lastAttempt, lastAttempt],
    sql: "INSERT INTO token_attempts (ip, recent_tokens, locked_until, window_start, last_attempt) VALUES (?, ?, ?, ?, ?)",
  });
  return ipHash;
};

/** Is a token_attempts row with this ip hash still in the DB? */
const tokenAttemptExists = async (ipHash: string): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [ipHash],
    sql: "SELECT 1 FROM token_attempts WHERE ip = ?",
  });
  return rows.length > 0;
};

/** Insert a contact_preferences row with the given last_activity (ms-epoch).
 * Prune filters only on last_activity, so the hash/visits values are inert. */
const insertContactPreference = async (
  contactHash: string,
  lastActivityMs: number,
): Promise<void> => {
  await getDb().execute({
    args: [contactHash, lastActivityMs],
    sql: "INSERT INTO contact_preferences (contact_hash, last_activity, visits) VALUES (?, ?, 1)",
  });
};

/** Is a contact_preferences row with this hash still in the DB? */
const contactPreferenceExists = async (
  contactHash: string,
): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [contactHash],
    sql: "SELECT 1 FROM contact_preferences WHERE contact_hash = ?",
  });
  return rows.length > 0;
};

/** Is a processed_payments row with this session ID still in the DB? */
const paymentExists = async (sessionId: string): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [sessionId],
    sql: "SELECT 1 FROM processed_payments WHERE payment_session_id = ?",
  });
  return rows.length > 0;
};

/** Is a login_attempts row with this ip hash still in the DB? */
const loginAttemptExists = async (ipHash: string): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [ipHash],
    sql: "SELECT 1 FROM login_attempts WHERE ip = ?",
  });
  return rows.length > 0;
};

/** Clear all last_pruned_* timestamps so every task is due. */
const clearAllLastPruned = async (): Promise<void> => {
  await settings.update.lastPrunedPayments("");
  await settings.update.lastPrunedSessions("");
  await settings.update.lastPrunedLogins("");
  await settings.update.lastPrunedTokens("");
  await settings.update.lastPrunedSumup("");
  await settings.update.lastPrunedContacts("");
};

/** Set all last_pruned_* timestamps to the same value. */
const setAllLastPruned = async (value: string): Promise<void> => {
  await settings.update.lastPrunedPayments(value);
  await settings.update.lastPrunedSessions(value);
  await settings.update.lastPrunedLogins(value);
  await settings.update.lastPrunedTokens(value);
  await settings.update.lastPrunedSumup(value);
  await settings.update.lastPrunedContacts(value);
};

describeWithEnv("db > prune", { db: true }, () => {
  describe("prunePayments", () => {
    test("deletes finalized payments older than retention window", async () => {
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_old", old);

      await prunePayments();

      expect(await paymentExists("sess_old")).toBe(false);
    });

    test("keeps finalized payments within retention window", async () => {
      const recent = new Date(nowMs() - 1000).toISOString();
      await insertFinalizedPayment("sess_recent", recent);

      await prunePayments();

      expect(await paymentExists("sess_recent")).toBe(true);
    });

    test("leaves unfinalized reservations alone regardless of age", async () => {
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertUnfinalizedPayment("sess_unfinalized", old);

      await prunePayments();

      expect(await paymentExists("sess_unfinalized")).toBe(true);
    });

    test("deletes recorded terminal failures older than retention window", async () => {
      // A handled failure (refund issued) is a resolved outcome — once retries
      // can no longer arrive, the idempotency row can be pruned like a success.
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFailedPayment("sess_failed_old", old);

      await prunePayments();

      expect(await paymentExists("sess_failed_old")).toBe(false);
    });

    test("keeps recorded terminal failures within retention window", async () => {
      // Inside the window a provider retry could still arrive, so the terminal
      // outcome must remain available to replay.
      const recent = new Date(nowMs() - 1000).toISOString();
      await insertFailedPayment("sess_failed_recent", recent);

      await prunePayments();

      expect(await paymentExists("sess_failed_recent")).toBe(true);
    });
  });

  describe("pruneSumupCheckouts", () => {
    test("deletes checkout metadata older than retention window", async () => {
      const old = new Date(
        nowMs() - PRUNE_SUMUP_RETENTION_MS - 60_000,
      ).toISOString();
      await insertSumupCheckout("idx_old", old);

      await pruneSumupCheckouts();

      expect(await sumupCheckoutExists("idx_old")).toBe(false);
    });

    test("keeps checkout metadata within retention window", async () => {
      const recent = new Date(nowMs() - 1000).toISOString();
      await insertSumupCheckout("idx_recent", recent);

      await pruneSumupCheckouts();

      expect(await sumupCheckoutExists("idx_recent")).toBe(true);
    });
  });

  describe("pruneSessions", () => {
    test("deletes sessions whose expiry is past the retention window", async () => {
      const expiredMs = nowMs() - PRUNE_SESSIONS_RETENTION_MS - 60_000;
      await createSession("stale-tok", "csrf-stale", expiredMs, null, 1);

      await pruneSessions();

      const remaining = await getAllSessions();
      expect(remaining.map((s) => s.csrf_token)).not.toContain("csrf-stale");
    });

    test("keeps active sessions with future expiry", async () => {
      await createSession(
        "active-tok",
        "csrf-active",
        nowMs() + 60 * 60 * 1000,
        null,
        1,
      );

      await pruneSessions();

      const remaining = await getAllSessions();
      expect(remaining.map((s) => s.csrf_token)).toContain("csrf-active");
    });

    test("keeps recently-expired sessions within retention grace", async () => {
      await createSession(
        "fresh-expired",
        "csrf-fresh-expired",
        nowMs() - 1_000,
        null,
        1,
      );

      await pruneSessions();

      const remaining = await getAllSessions();
      expect(remaining.map((s) => s.csrf_token)).toContain(
        "csrf-fresh-expired",
      );
    });
  });

  describe("pruneLoginAttempts", () => {
    test("deletes rows with lockouts past retention window", async () => {
      const ipHash = await insertLoginAttempt(
        "1.2.3.4",
        5,
        nowMs() - PRUNE_LOGINS_RETENTION_MS - 60_000,
      );

      await pruneLoginAttempts();

      expect(await loginAttemptExists(ipHash)).toBe(false);
    });

    test("keeps counter-only rows (locked_until IS NULL)", async () => {
      const ipHash = await insertLoginAttempt("5.6.7.8", 2, null);

      await pruneLoginAttempts();

      expect(await loginAttemptExists(ipHash)).toBe(true);
    });

    test("keeps rows with currently-active lockouts", async () => {
      const ipHash = await insertLoginAttempt(
        "9.10.11.12",
        5,
        nowMs() + 60_000,
      );

      await pruneLoginAttempts();

      expect(await loginAttemptExists(ipHash)).toBe(true);
    });
  });

  describe("pruneTokenAttempts", () => {
    test("deletes rows untouched past the retention window", async () => {
      const stale = nowMs() - PRUNE_TOKENS_RETENTION_MS - 60_000;
      const ipHash = await insertTokenAttempt("13.14.15.16", null, stale);

      await pruneTokenAttempts();

      expect(await tokenAttemptExists(ipHash)).toBe(false);
    });

    test("keeps rows with a recent last_attempt", async () => {
      const ipHash = await insertTokenAttempt("17.18.19.20", null, nowMs());

      await pruneTokenAttempts();

      expect(await tokenAttemptExists(ipHash)).toBe(true);
    });

    test("deletes stale rows even when a lockout is still active", async () => {
      const stale = nowMs() - PRUNE_TOKENS_RETENTION_MS - 60_000;
      const ipHash = await insertTokenAttempt(
        "21.22.23.24",
        nowMs() + 60_000,
        stale,
      );

      await pruneTokenAttempts();

      expect(await tokenAttemptExists(ipHash)).toBe(false);
    });
  });

  describe("pruneContacts", () => {
    test("deletes rows whose last_activity is past the retention window", async () => {
      const stale = nowMs() - PRUNE_CONTACTS_RETENTION_MS - 60_000;
      await insertContactPreference("contact_stale", stale);

      await pruneContacts();

      expect(await contactPreferenceExists("contact_stale")).toBe(false);
    });

    test("keeps rows with recent activity within the retention window", async () => {
      await insertContactPreference("contact_recent", nowMs() - 1_000);

      await pruneContacts();

      expect(await contactPreferenceExists("contact_recent")).toBe(true);
    });

    test("keeps a row whose last_activity is exactly at the cutoff", async () => {
      // The query deletes last_activity < cutoff (strict), so a row exactly at
      // the cutoff survives — the boundary belongs to "keep".
      const time = new FakeTime(1_700_000_000_000);
      try {
        const cutoff = nowMs() - PRUNE_CONTACTS_RETENTION_MS;
        await insertContactPreference("contact_boundary", cutoff);

        await pruneContacts();

        expect(await contactPreferenceExists("contact_boundary")).toBe(true);
      } finally {
        time.restore();
      }
    });

    test("deletes a row one ms past the cutoff", async () => {
      const time = new FakeTime(1_700_000_000_000);
      try {
        const cutoff = nowMs() - PRUNE_CONTACTS_RETENTION_MS;
        await insertContactPreference("contact_just_past", cutoff - 1);

        await pruneContacts();

        expect(await contactPreferenceExists("contact_just_past")).toBe(false);
      } finally {
        time.restore();
      }
    });
  });

  describe("maybeRunPrunes scheduler", () => {
    test("records fresh payments timestamp after running", async () => {
      await clearAllLastPruned();
      const before = nowMs();

      await maybeRunPrunes();

      const ts = Number.parseInt(settings.lastPrunedPayments, 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(nowMs());
    });

    test("records fresh sessions timestamp after running", async () => {
      await clearAllLastPruned();
      const before = nowMs();

      await maybeRunPrunes();

      const ts = Number.parseInt(settings.lastPrunedSessions, 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(nowMs());
    });

    test("records fresh sumup timestamp after running", async () => {
      await clearAllLastPruned();
      const before = nowMs();

      await maybeRunPrunes();

      const ts = Number.parseInt(settings.lastPrunedSumup, 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(nowMs());
    });

    test("records fresh logins timestamp after running", async () => {
      await clearAllLastPruned();
      const before = nowMs();

      await maybeRunPrunes();

      const ts = Number.parseInt(settings.lastPrunedLogins, 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(nowMs());
    });

    test("records fresh tokens timestamp after running", async () => {
      await clearAllLastPruned();
      const before = nowMs();

      await maybeRunPrunes();

      const ts = Number.parseInt(settings.lastPrunedTokens, 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(nowMs());
    });

    test("records fresh contacts timestamp and prunes stale contacts", async () => {
      await clearAllLastPruned();
      const stale = nowMs() - PRUNE_CONTACTS_RETENTION_MS - 60_000;
      await insertContactPreference("contact_scheduled", stale);
      const before = nowMs();

      await maybeRunPrunes();

      const ts = Number.parseInt(settings.lastPrunedContacts, 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(nowMs());
      expect(await contactPreferenceExists("contact_scheduled")).toBe(false);
    });

    test("skips tasks not yet due since last run", async () => {
      await setAllLastPruned(String(nowMs()));
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_skip", old);

      await maybeRunPrunes();

      expect(await paymentExists("sess_skip")).toBe(true);
    });

    test("runs tasks when last-run is older than the interval", async () => {
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_due", old);
      await setAllLastPruned(String(nowMs() - PRUNE_INTERVAL_MS - 60_000));

      await maybeRunPrunes();

      expect(await paymentExists("sess_due")).toBe(false);
    });

    test("one task's failure does not block the others", async () => {
      // Insert a prunable payment so we can verify its task actually ran.
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_isolation", old);

      await clearAllLastPruned();

      // Drop sessions so pruneSessions fails; payments + logins should still run.
      await getDb().execute("DROP TABLE sessions");

      await maybeRunPrunes();

      expect(await paymentExists("sess_isolation")).toBe(false);
    });

    test("treats an invalid last-pruned value as never-run", async () => {
      await settings.update.lastPrunedPayments("not-a-number");
      const before = nowMs();

      await maybeRunPrunes();

      const ts = Number.parseInt(settings.lastPrunedPayments, 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(nowMs());
    });

    test("concurrent calls leave the DB in a consistent state", async () => {
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_concurrent", old);
      await clearAllLastPruned();

      await Promise.all([maybeRunPrunes(), maybeRunPrunes(), maybeRunPrunes()]);

      expect(await paymentExists("sess_concurrent")).toBe(false);
    });
  });

  test("a task becomes due exactly PRUNE_INTERVAL_MS after its last run", async () => {
    const start = 1_700_000_000_000;
    const time = new FakeTime(start);
    try {
      await setAllLastPruned(String(start));
      const old = new Date(
        start - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_interval", old);

      time.tick(PRUNE_INTERVAL_MS - 1);
      await maybeRunPrunes();
      expect(await paymentExists("sess_interval")).toBe(true);

      time.tick(1);
      await maybeRunPrunes();
      expect(await paymentExists("sess_interval")).toBe(false);
    } finally {
      time.restore();
    }
  });
});
