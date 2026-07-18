import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { createSession, getAllSessions } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  PRUNE_CONTACTS_RETENTION_MS,
  PRUNE_LOGINS_RETENTION_MS,
  PRUNE_SESSIONS_RETENTION_MS,
  PRUNE_SUMUP_RETENTION_MS,
  PRUNE_TOKENS_RETENTION_MS,
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
} from "#shared/limits.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  attendeeExists,
  contactPreferenceExists,
  insertContactPreference,
  insertLoginAttempt,
  insertOrphanAttendee,
  insertString,
  insertSumupCheckout,
  insertTokenAttempt,
  loginAttemptExists,
  oldOrphanIso,
  stringExists,
  sumupCheckoutExists,
  tokenAttemptExists,
} from "./helpers.ts";

describeWithEnv("db > table pruning", { db: true }, () => {
  test("logs the exact total number of deleted rows", async () => {
    setSuppressDebugLogs(false);
    const debugStub = stub(console, "debug");
    try {
      const old = new Date(
        nowMs() - PRUNE_SUMUP_RETENTION_MS - 60_000,
      ).toISOString();
      await insertSumupCheckout("idx_first", old);
      await insertSumupCheckout("idx_second", old);

      await runDatabasePruning();

      const pruneLogs = debugStub.calls
        .map((call) => String(call.args[0]))
        .filter((line) => line.includes("[Prune]"));
      expect(pruneLogs).toHaveLength(1);
      expect(pruneLogs[0]).toMatch(/\[Prune\] deleted 2 expired rows$/);
    } finally {
      debugStub.restore();
      setSuppressDebugLogs(null);
    }
  });

  describe("pruneSumupCheckouts", () => {
    test("deletes checkout metadata older than retention window", async () => {
      const old = new Date(
        nowMs() - PRUNE_SUMUP_RETENTION_MS - 60_000,
      ).toISOString();
      await insertSumupCheckout("idx_old", old);

      await runDatabasePruning();

      expect(await sumupCheckoutExists("idx_old")).toBe(false);
    });

    test("keeps checkout metadata within retention window", async () => {
      const recent = new Date(nowMs() - 1000).toISOString();
      await insertSumupCheckout("idx_recent", recent);

      await runDatabasePruning();

      expect(await sumupCheckoutExists("idx_recent")).toBe(true);
    });
  });

  describe("pruneUnusedStrings", () => {
    test("deletes unused strings older than retention window", async () => {
      const old = new Date(
        nowMs() - PRUNE_UNUSED_STRINGS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertString("string_old_unused", old, 0);

      await runDatabasePruning();

      expect(await stringExists("string_old_unused")).toBe(false);
    });

    test("keeps unused strings within retention window", async () => {
      const recent = new Date(nowMs() - 1000).toISOString();
      await insertString("string_recent_unused", recent, 0);

      await runDatabasePruning();

      expect(await stringExists("string_recent_unused")).toBe(true);
    });

    test("keeps referenced strings even when older than retention window", async () => {
      const old = new Date(
        nowMs() - PRUNE_UNUSED_STRINGS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertString("string_old_used", old, 1);

      await runDatabasePruning();

      expect(await stringExists("string_old_used")).toBe(true);
    });
  });

  describe("pruneSessions", () => {
    test("deletes sessions whose expiry is past the retention window", async () => {
      const expiredMs = nowMs() - PRUNE_SESSIONS_RETENTION_MS - 60_000;
      await createSession("stale-tok", "csrf-stale", expiredMs, null, 1);

      await runDatabasePruning();

      const remaining = await getAllSessions();
      expect(remaining.map((session) => session.csrf_token)).not.toContain(
        "csrf-stale",
      );
    });

    test("keeps active sessions with future expiry", async () => {
      await createSession(
        "active-tok",
        "csrf-active",
        nowMs() + 60 * 60 * 1000,
        null,
        1,
      );

      await runDatabasePruning();

      const remaining = await getAllSessions();
      expect(remaining.map((session) => session.csrf_token)).toContain(
        "csrf-active",
      );
    });

    test("keeps recently-expired sessions within retention grace", async () => {
      await createSession(
        "fresh-expired",
        "csrf-fresh-expired",
        nowMs() - 1_000,
        null,
        1,
      );

      await runDatabasePruning();

      const remaining = await getAllSessions();
      expect(remaining.map((session) => session.csrf_token)).toContain(
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

      await runDatabasePruning();

      expect(await loginAttemptExists(ipHash)).toBe(false);
    });

    test("keeps counter-only rows (locked_until IS NULL)", async () => {
      const ipHash = await insertLoginAttempt("5.6.7.8", 2, null);

      await runDatabasePruning();

      expect(await loginAttemptExists(ipHash)).toBe(true);
    });

    test("keeps rows with currently-active lockouts", async () => {
      const ipHash = await insertLoginAttempt(
        "9.10.11.12",
        5,
        nowMs() + 60_000,
      );

      await runDatabasePruning();

      expect(await loginAttemptExists(ipHash)).toBe(true);
    });
  });

  describe("pruneTokenAttempts", () => {
    test("deletes rows untouched past the retention window", async () => {
      const stale = nowMs() - PRUNE_TOKENS_RETENTION_MS - 60_000;
      const ipHash = await insertTokenAttempt("13.14.15.16", null, stale);

      await runDatabasePruning();

      expect(await tokenAttemptExists(ipHash)).toBe(false);
    });

    test("keeps rows with a recent last_attempt", async () => {
      const ipHash = await insertTokenAttempt("17.18.19.20", null, nowMs());

      await runDatabasePruning();

      expect(await tokenAttemptExists(ipHash)).toBe(true);
    });

    test("deletes stale rows even when a lockout is still active", async () => {
      const stale = nowMs() - PRUNE_TOKENS_RETENTION_MS - 60_000;
      const ipHash = await insertTokenAttempt(
        "21.22.23.24",
        nowMs() + 60_000,
        stale,
      );

      await runDatabasePruning();

      expect(await tokenAttemptExists(ipHash)).toBe(false);
    });
  });

  describe("pruneContacts", () => {
    test("deletes subscribed rows older than the retention window", async () => {
      const stale = nowMs() - PRUNE_CONTACTS_RETENTION_MS - 60_000;
      await insertContactPreference("contact_old", 0, stale);

      await runDatabasePruning();

      expect(await contactPreferenceExists("contact_old")).toBe(false);
    });

    test("keeps subscribed rows within the retention window", async () => {
      await insertContactPreference("contact_recent", 0, nowMs());

      await runDatabasePruning();

      expect(await contactPreferenceExists("contact_recent")).toBe(true);
    });

    test("keeps unsubscribed rows older than the retention window", async () => {
      const stale = nowMs() - PRUNE_CONTACTS_RETENTION_MS - 60_000;
      await insertContactPreference("contact_opt_out", 1, stale);

      await runDatabasePruning();

      expect(await contactPreferenceExists("contact_opt_out")).toBe(true);
    });
  });

  describe("pruneOrphanAttendees", () => {
    test("keeps old orphans while automatic purging is off", async () => {
      await settings.update.autoPurgeOrphans(false);
      const id = await insertOrphanAttendee(oldOrphanIso());

      await runDatabasePruning();

      expect(await attendeeExists(id)).toBe(true);
    });

    test("deletes orphans older than the configured retention", async () => {
      await settings.update.orphanPurgeRetention("182");
      const id = await insertOrphanAttendee(oldOrphanIso());

      await runDatabasePruning();

      expect(await attendeeExists(id)).toBe(false);
    });

    test("keeps orphans newer than the configured retention", async () => {
      await settings.update.orphanPurgeRetention("1825");
      const id = await insertOrphanAttendee(oldOrphanIso());

      await runDatabasePruning();

      expect(await attendeeExists(id)).toBe(true);
    });
  });
});
