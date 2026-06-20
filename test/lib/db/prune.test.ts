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
  pruneOrphanAttendees,
  prunePayments,
  pruneSessions,
  pruneSumupCheckouts,
  pruneTokenAttempts,
  pruneUnusedStrings,
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
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
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

/** Insert an encrypted string row with the given timestamp and usage count. */
const insertString = async (
  textIndex: string,
  created: string,
  usedCount: number,
): Promise<void> => {
  await getDb().execute(
    insert("strings", {
      created,
      encrypted_text: "ciphertext",
      text_index: textIndex,
      used_count: usedCount,
    }),
  );
};

/** Is a string row with this text index still in the DB? */
const stringExists = async (textIndex: string): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [textIndex],
    sql: "SELECT 1 FROM strings WHERE text_index = ?",
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

/** Insert a contact preference row with the given activity timestamp. */
const insertContactPreference = async (
  hash: string,
  unsubscribed: number,
  lastActivity: number,
): Promise<void> => {
  await getDb().execute({
    args: [hash, unsubscribed, lastActivity],
    sql: "INSERT INTO contact_preferences (contact_hash, unsubscribed, visits, stats_blob, last_activity) VALUES (?, ?, 1, '', ?)",
  });
};

/** Insert an orphaned attendee (no listing booking) with the given created
 * timestamp, returning its id. */
const insertOrphanAttendee = async (createdIso: string): Promise<number> => {
  const result = await getDb().execute(
    insert("attendees", {
      created: createdIso,
      pii_blob: "",
      ticket_token_index: `prune-orphan-${crypto.randomUUID()}`,
    }),
  );
  return Number(result.lastInsertRowid);
};

/** Is an attendee row with this id still in the DB? */
const attendeeExists = async (id: number): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [id],
    sql: "SELECT 1 FROM attendees WHERE id = ?",
  });
  return rows.length > 0;
};

/** An orphan created a year ago — older than every retention except "5 years". */
const oldOrphanIso = (): string =>
  new Date(nowMs() - 365 * 24 * 60 * 60 * 1000).toISOString();

/** Is a token_attempts row with this ip hash still in the DB? */
const tokenAttemptExists = async (ipHash: string): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [ipHash],
    sql: "SELECT 1 FROM token_attempts WHERE ip = ?",
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

/** Is a contact_preferences row with this hash still in the DB? */
const contactPreferenceExists = async (hash: string): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [hash],
    sql: "SELECT 1 FROM contact_preferences WHERE contact_hash = ?",
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
  await settings.update.lastPrunedStrings("");
  await settings.update.lastPrunedContacts("");
  await settings.update.lastPrunedInvites("");
  await settings.update.lastPrunedOrphans("");
};

/** Set all last_pruned_* timestamps to the same value. */
const setAllLastPruned = async (value: string): Promise<void> => {
  await settings.update.lastPrunedPayments(value);
  await settings.update.lastPrunedSessions(value);
  await settings.update.lastPrunedLogins(value);
  await settings.update.lastPrunedTokens(value);
  await settings.update.lastPrunedSumup(value);
  await settings.update.lastPrunedStrings(value);
  await settings.update.lastPrunedContacts(value);
  await settings.update.lastPrunedInvites(value);
  await settings.update.lastPrunedOrphans(value);
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

  describe("pruneUnusedStrings", () => {
    test("deletes unused strings older than retention window", async () => {
      const old = new Date(
        nowMs() - PRUNE_UNUSED_STRINGS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertString("string_old_unused", old, 0);

      await pruneUnusedStrings();

      expect(await stringExists("string_old_unused")).toBe(false);
    });

    test("keeps unused strings within retention window", async () => {
      const recent = new Date(nowMs() - 1000).toISOString();
      await insertString("string_recent_unused", recent, 0);

      await pruneUnusedStrings();

      expect(await stringExists("string_recent_unused")).toBe(true);
    });

    test("keeps referenced strings even when older than retention window", async () => {
      const old = new Date(
        nowMs() - PRUNE_UNUSED_STRINGS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertString("string_old_used", old, 1);

      await pruneUnusedStrings();

      expect(await stringExists("string_old_used")).toBe(true);
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
    test("deletes subscribed rows older than the retention window", async () => {
      const stale = nowMs() - PRUNE_CONTACTS_RETENTION_MS - 60_000;
      await insertContactPreference("contact_old", 0, stale);

      await pruneContacts();

      expect(await contactPreferenceExists("contact_old")).toBe(false);
    });

    test("keeps subscribed rows within the retention window", async () => {
      await insertContactPreference("contact_recent", 0, nowMs());

      await pruneContacts();

      expect(await contactPreferenceExists("contact_recent")).toBe(true);
    });

    test("keeps unsubscribed rows older than the retention window", async () => {
      const stale = nowMs() - PRUNE_CONTACTS_RETENTION_MS - 60_000;
      await insertContactPreference("contact_opt_out", 1, stale);

      await pruneContacts();

      expect(await contactPreferenceExists("contact_opt_out")).toBe(true);
    });
  });

  describe("pruneOrphanAttendees", () => {
    test("deletes orphans older than the configured retention", async () => {
      await settings.update.orphanPurgeRetention("182");
      const id = await insertOrphanAttendee(oldOrphanIso());

      await pruneOrphanAttendees();

      expect(await attendeeExists(id)).toBe(false);
    });

    test("keeps orphans newer than the configured retention", async () => {
      await settings.update.orphanPurgeRetention("1825");
      const id = await insertOrphanAttendee(oldOrphanIso());

      await pruneOrphanAttendees();

      expect(await attendeeExists(id)).toBe(true);
    });
  });

  describe("orphan auto-purge scheduling", () => {
    test("maybeRunPrunes purges orphans when auto-purge is on", async () => {
      await settings.update.autoPurgeOrphans(true);
      await settings.update.orphanPurgeRetention("182");
      await clearAllLastPruned();
      const id = await insertOrphanAttendee(oldOrphanIso());

      await maybeRunPrunes();

      expect(await attendeeExists(id)).toBe(false);
      expect(settings.lastPrunedOrphans).not.toBe("");
    });

    test("maybeRunPrunes leaves orphans alone when auto-purge is off", async () => {
      await settings.update.autoPurgeOrphans(false);
      await clearAllLastPruned();
      const id = await insertOrphanAttendee(oldOrphanIso());

      await maybeRunPrunes();

      expect(await attendeeExists(id)).toBe(true);
      expect(settings.lastPrunedOrphans).toBe("");
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

    test("records fresh strings timestamp after running", async () => {
      await clearAllLastPruned();
      const before = nowMs();

      await maybeRunPrunes();

      const ts = Number.parseInt(settings.lastPrunedStrings, 10);
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

    test("records fresh contacts timestamp after running", async () => {
      await clearAllLastPruned();
      const before = nowMs();

      await maybeRunPrunes();

      const ts = Number.parseInt(settings.lastPrunedContacts, 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(nowMs());
    });

    test("records fresh invites timestamp after running", async () => {
      await clearAllLastPruned();
      const before = nowMs();

      await maybeRunPrunes();

      const ts = Number.parseInt(settings.lastPrunedInvites, 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(nowMs());
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
