import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, insert } from "#shared/db/client.ts";
import {
  batchFinalizeStatement,
  finalizeSession as finalizePaymentSession,
  isSessionProcessed,
  markSessionFailed,
  parseSessionFailure,
  reserveSession,
  STALE_RESERVATION_MS,
  setSessionTicketTokens,
} from "#shared/db/processed-payments.ts";
import { nowMs } from "#shared/now.ts";
import { bookAttendee, createTestListing, describeWithEnv } from "#test-utils";

describeWithEnv("db > processed payments", { db: true }, () => {
  describe("reserveSession", () => {
    test("succeeds on first call", async () => {
      const result = await reserveSession("sess_test_1");
      expect(result.reserved).toBe(true);
    });

    test("returns existing when session already reserved and finalized", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendeeResult = await bookAttendee(listing, {
        email: "test@example.com",
        name: "Test",
      });
      if (!attendeeResult.success) throw new Error("Failed to create attendee");

      await reserveSession("sess_dup");
      await finalizePaymentSession(
        "sess_dup",
        attendeeResult.attendees[0]!.id,
        ["tok-test"],
      );

      const result = await reserveSession("sess_dup");
      expect(result.reserved).toBe(false);
      if (!result.reserved) {
        expect(result.existing.attendee_id).toBe(
          attendeeResult.attendees[0]!.id,
        );
      }
    });

    test("returns existing when session is reserved but not finalized", async () => {
      await reserveSession("sess_unfinalized");

      const result = await reserveSession("sess_unfinalized");
      expect(result.reserved).toBe(false);
      if (!result.reserved) {
        expect(result.existing.attendee_id).toBeNull();
      }
    });

    test("retries when stale reservation detected", async () => {
      const oldTimestamp = new Date(
        nowMs() - STALE_RESERVATION_MS - 1000,
      ).toISOString();
      await getDb().execute(
        insert("processed_payments", {
          attendee_id: null,
          payment_session_id: "sess_stale",
          processed_at: oldTimestamp,
        }),
      );

      const result = await reserveSession("sess_stale");
      expect(result.reserved).toBe(true);

      // Session was successfully re-reserved and is now tracked
      const processed = await isSessionProcessed("sess_stale");
      expect(processed).not.toBeNull();
    });

    test("records and replays a terminal failure round-trip", async () => {
      await reserveSession("sess_failrt");
      await markSessionFailed("sess_failrt", {
        error: "Sold out",
        refunded: true,
        status: 409,
      });
      const row = await isSessionProcessed("sess_failrt");
      expect(await parseSessionFailure(row!.failure_data)).toEqual({
        error: "Sold out",
        refunded: true,
        status: 409,
      });
    });

    test("stores failure_data encrypted at rest, not as plaintext", async () => {
      await reserveSession("sess_failenc");
      await markSessionFailed("sess_failenc", {
        error: "Private Listing Name sold out",
        status: 409,
      });
      const row = await isSessionProcessed("sess_failenc");
      // The raw column is ciphertext: the user-facing message can embed an
      // encrypted-at-rest listing name, so it must not be stored in the clear.
      expect(row!.failure_data).not.toContain("Private Listing Name");
      expect(row!.failure_data).not.toBe(
        '{"error":"Private Listing Name sold out","status":409}',
      );
      // ...but it still round-trips back to the original via decrypt.
      expect(await parseSessionFailure(row!.failure_data)).toEqual({
        error: "Private Listing Name sold out",
        status: 409,
      });
    });

    test("does not overwrite an already-recorded failure (first outcome wins)", async () => {
      await reserveSession("sess_failtwice");
      await markSessionFailed("sess_failtwice", {
        error: "First",
        status: 410,
      });
      await markSessionFailed("sess_failtwice", {
        error: "Second",
        status: 409,
      });
      const row = await isSessionProcessed("sess_failtwice");
      expect((await parseSessionFailure(row!.failure_data))?.error).toBe(
        "First",
      );
    });

    test("never stamps a failure onto a finalized (successful) session", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await bookAttendee(listing, {
        email: "f@example.com",
        name: "F",
      });
      if (!attendee.success) throw new Error("setup failed");
      await reserveSession("sess_finalized_nofail");
      await finalizePaymentSession(
        "sess_finalized_nofail",
        attendee.attendees[0]!.id,
        ["tok-test"],
      );

      await markSessionFailed("sess_finalized_nofail", { error: "late fail" });

      const row = await isSessionProcessed("sess_finalized_nofail");
      // The success is preserved: attendee_id intact, no failure recorded.
      expect(row!.attendee_id).toBe(attendee.attendees[0]!.id);
      expect(row!.failure_data).toBe("");
    });

    test("parseSessionFailure returns null when no failure is recorded", async () => {
      expect(await parseSessionFailure("")).toBeNull();
    });

    test("parseSessionFailure degrades undecryptable data to a terminal failure instead of throwing", async () => {
      const result = await parseSessionFailure("not valid ciphertext{");
      // A value that won't decrypt/parse must not crash the replay path; it
      // resolves to a generic terminal failure (non-empty message, 500 status).
      expect(result?.status).toBe(500);
      expect((result?.error.length ?? 0) > 0).toBe(true);
    });

    test("re-throws non-unique-constraint errors", async () => {
      await getDb().execute("DROP TABLE processed_payments");

      try {
        await reserveSession("sess_error");
        throw new Error("should not reach here");
      } catch (e) {
        expect(String(e)).not.toContain("should not reach here");
        expect(String(e)).not.toContain("UNIQUE constraint");
      }

      // Recreate the table for subsequent tests
      await getDb().execute(`
        CREATE TABLE IF NOT EXISTS processed_payments (
          payment_session_id TEXT PRIMARY KEY,
          attendee_id INTEGER,
          processed_at TEXT NOT NULL,
          ticket_tokens TEXT NOT NULL DEFAULT '',
          failure_data TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (attendee_id) REFERENCES attendees(id)
        )
      `);
    });
  });

  describe("batchFinalizeStatement", () => {
    // The booking batch passes the attendee id as a MAX(id) subquery; a direct
    // unit test binds it as a literal `?` and uses a trivially-true guard, so it
    // exercises the UNRESOLVED + guard gating without an in-batch attendee row.
    const trueGuard = { args: [] as never[], sql: "1 = 1" };

    test("sets attendee_id and clears ticket_tokens on an unresolved reservation", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const attendeeResult = await bookAttendee(listing, {
        email: "fss@example.com",
        name: "Fss",
      });
      if (!attendeeResult.success) throw new Error("setup failed");
      const attendeeId = attendeeResult.attendees[0]!.id;

      await reserveSession("sess_fss");
      const stmt = batchFinalizeStatement(
        "sess_fss",
        "?",
        attendeeId,
        trueGuard,
      );
      await getDb().execute(stmt);

      const row = await isSessionProcessed("sess_fss");
      expect(row!.attendee_id).toBe(attendeeId);
      expect(row!.ticket_tokens).toBe("");
    });

    test("is a no-op when the session is already finalized", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const attendeeResult = await bookAttendee(listing, {
        email: "fss2@example.com",
        name: "Fss2",
      });
      if (!attendeeResult.success) throw new Error("setup failed");
      const attendeeId = attendeeResult.attendees[0]!.id;

      await reserveSession("sess_fss2");
      await finalizePaymentSession("sess_fss2", attendeeId, ["tok-test"]);

      // A second finalize (different attendee id) must not overwrite
      const stmt = batchFinalizeStatement(
        "sess_fss2",
        "?",
        attendeeId + 999,
        trueGuard,
      );
      await getDb().execute(stmt);

      const row = await isSessionProcessed("sess_fss2");
      expect(row!.attendee_id).toBe(attendeeId);
    });

    test("does not finalize when the all-bookings-landed guard fails", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const attendeeResult = await bookAttendee(listing, {
        email: "fss3@example.com",
        name: "Fss3",
      });
      if (!attendeeResult.success) throw new Error("setup failed");
      const attendeeId = attendeeResult.attendees[0]!.id;

      await reserveSession("sess_fss3");
      // A guard that never holds stands in for a partial cart (not every booking
      // landed): the session must stay unresolved so the caller can refund.
      const stmt = batchFinalizeStatement("sess_fss3", "?", attendeeId, {
        args: [],
        sql: "1 = 0",
      });
      await getDb().execute(stmt);

      const row = await isSessionProcessed("sess_fss3");
      expect(row!.attendee_id).toBe(null);
    });
  });

  describe("setSessionTicketTokens", () => {
    test("stores encrypted ticket tokens on a finalized session", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const attendeeResult = await bookAttendee(listing, {
        email: "stt@example.com",
        name: "Stt",
      });
      if (!attendeeResult.success) throw new Error("setup failed");
      const attendeeId = attendeeResult.attendees[0]!.id;

      await reserveSession("sess_stt");
      await finalizePaymentSession("sess_stt", attendeeId, ["tok-test"]);
      await setSessionTicketTokens("sess_stt", ["tok-abc"]);

      const row = await isSessionProcessed("sess_stt");
      // ticket_tokens is stored encrypted, not as plaintext
      expect(row!.ticket_tokens).not.toBe("");
      expect(row!.ticket_tokens).not.toContain("tok-abc");
    });

    test("is a no-op if the session was pruned", async () => {
      // Should not throw even when the session row is absent
      await setSessionTicketTokens("sess_nonexistent", ["tok-abc"]);
    });
  });
});
