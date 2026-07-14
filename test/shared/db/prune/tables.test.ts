import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  pruneCheckoutStages,
  pruneContacts,
  pruneLoginAttempts,
  pruneOrphanAttendees,
  pruneSessions,
  pruneSumupCheckouts,
  pruneTokenAttempts,
  pruneUnusedStrings,
} from "#shared/db/prune.ts";
import { createSession, getAllSessions } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  PRUNE_CHECKOUT_STAGES_RETENTION_MS,
  PRUNE_CONTACTS_RETENTION_MS,
  PRUNE_LOGINS_RETENTION_MS,
  PRUNE_PAYMENTS_RETENTION_MS,
  PRUNE_SESSIONS_RETENTION_MS,
  PRUNE_SUMUP_RETENTION_MS,
  PRUNE_TOKENS_RETENTION_MS,
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
  STALE_RESERVATION_MS,
} from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  attendeeExists,
  checkoutStageExists,
  contactPreferenceExists,
  insertContactPreference,
  insertLoginAttempt,
  insertOrphanAttendee,
  insertPendingCheckoutStage,
  insertString,
  insertSumupCheckout,
  insertTokenAttempt,
  insertUnfinalizedPayment,
  loginAttemptExists,
  oldOrphanIso,
  paymentExists,
  stringExists,
  sumupCheckoutExists,
  tokenAttemptExists,
} from "./helpers.ts";

describeWithEnv("db > table pruning", { db: true }, () => {
  describe("pruneCheckoutStages", () => {
    test("deletes pending checkout PII older than retention", async () => {
      const old = new Date(
        nowMs() - PRUNE_CHECKOUT_STAGES_RETENTION_MS - 60_000,
      ).toISOString();
      const attendeeId = await insertPendingCheckoutStage("stage_old", old);

      expect(await pruneCheckoutStages()).toBe(1);
      expect(await attendeeExists(attendeeId)).toBe(false);
    });

    test("keeps pending checkout PII within retention", async () => {
      const attendeeId = await insertPendingCheckoutStage(
        "stage_recent",
        new Date(nowMs() - 1000).toISOString(),
      );

      expect(await pruneCheckoutStages()).toBe(0);
      expect(await attendeeExists(attendeeId)).toBe(true);
    });

    test("deletes an old stage after clearing its stale payment claim", async () => {
      const oldStage = new Date(
        nowMs() - PRUNE_CHECKOUT_STAGES_RETENTION_MS - 60_000,
      ).toISOString();
      const staleClaim = new Date(
        nowMs() - STALE_RESERVATION_MS - 60_000,
      ).toISOString();
      const attendeeId = await insertPendingCheckoutStage(
        "stage_stale_claim",
        oldStage,
      );
      await insertUnfinalizedPayment("stage_stale_claim", staleClaim);

      expect(await pruneCheckoutStages()).toBe(1);
      expect(await attendeeExists(attendeeId)).toBe(false);
      expect(await checkoutStageExists("stage_stale_claim")).toBe(false);
      expect(await paymentExists("stage_stale_claim")).toBe(false);
    });

    test("keeps an old stage while its payment claim is fresh", async () => {
      const oldStage = new Date(
        nowMs() - PRUNE_CHECKOUT_STAGES_RETENTION_MS - 60_000,
      ).toISOString();
      const attendeeId = await insertPendingCheckoutStage(
        "stage_fresh_claim",
        oldStage,
      );
      await insertUnfinalizedPayment(
        "stage_fresh_claim",
        new Date(nowMs() - 1000).toISOString(),
      );

      expect(await pruneCheckoutStages()).toBe(0);
      expect(await attendeeExists(attendeeId)).toBe(true);
      expect(await checkoutStageExists("stage_fresh_claim")).toBe(true);
    });

    test("deletes resolved stage replay guards after payment retention", async () => {
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      const attendeeId = await insertPendingCheckoutStage(
        "stage_old_resolved",
        old,
      );
      await getDb().execute(
        "UPDATE checkout_stages SET state = 'failed', ticket_tokens = '' WHERE payment_session_id = ?",
        ["stage_old_resolved"],
      );

      expect(await pruneCheckoutStages()).toBe(1);
      expect(await checkoutStageExists("stage_old_resolved")).toBe(false);
      expect(await attendeeExists(attendeeId)).toBe(true);
    });

    test("keeps resolved stage replay guards within payment retention", async () => {
      const attendeeId = await insertPendingCheckoutStage(
        "stage_recent_resolved",
        new Date(nowMs() - 1000).toISOString(),
      );
      await getDb().execute(
        "UPDATE checkout_stages SET state = 'booked', ticket_tokens = '' WHERE payment_session_id = ?",
        ["stage_recent_resolved"],
      );

      expect(await pruneCheckoutStages()).toBe(0);
      expect(await checkoutStageExists("stage_recent_resolved")).toBe(true);
      expect(await attendeeExists(attendeeId)).toBe(true);
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

      await pruneSessions();

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

      await pruneSessions();

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
});
