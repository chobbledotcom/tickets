import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { getDb, insert } from "#shared/db/client.ts";
import { batchFinalizeStatement } from "#shared/db/payment-finalize.ts";
import {
  decryptSessionTokens,
  finalizeSession as finalizePaymentSession,
  finalizeSessionIfUnresolved,
  isSessionProcessed,
  isUnresolvedReservation,
  markSessionFailed,
  parseSessionFailure,
  reserveSession,
  STALE_RESERVATION_MS,
  setSessionTicketTokens,
} from "#shared/db/processed-payments.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectRefundReferences } from "#test-utils/payment-references.ts";

const finalizeSession = (
  sessionId: string,
  attendeeId: number,
  ticketTokens: string[],
) =>
  finalizePaymentSession(
    sessionId,
    attendeeId,
    ticketTokens,
    `pi_${sessionId}`,
  );

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
      await finalizeSession("sess_dup", attendeeResult.attendees[0]!.id, [
        "tok-test",
      ]);

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
      await finalizeSession(
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
      // Deliberately corrupt stored value — test fixture cast.
      const result = await parseSessionFailure(
        "not valid ciphertext{" as EnvKeyEncrypted,
      );
      // A value that won't decrypt/parse must not crash the replay path; it
      // resolves to a generic terminal failure (non-empty message, 500 status).
      expect(result?.status).toBe(500);
      expect((result?.error.length ?? 0) > 0).toBe(true);
    });

    test("re-throws non-unique-constraint errors", async () => {
      await getDb().execute(`
        CREATE TRIGGER reject_processed_payment_insert
        BEFORE INSERT ON processed_payments
        BEGIN
          SELECT RAISE(ABORT, 'synthetic insert failure');
        END
      `);

      await expect(reserveSession("sess_error")).rejects.toThrow(
        "synthetic insert failure",
      );
    });

    test("recognizes only attendee-less, outcome-less reservations as unresolved", async () => {
      await reserveSession("sess_unresolved_shape");
      const reserved = (await isSessionProcessed("sess_unresolved_shape"))!;

      expect(isUnresolvedReservation(reserved)).toBe(true);
      expect(isUnresolvedReservation({ ...reserved, attendee_id: 1 })).toBe(
        false,
      );
      expect(
        isUnresolvedReservation({
          ...reserved,
          failure_data: "recorded" as EnvKeyEncrypted,
        }),
      ).toBe(false);
    });
  });

  describe("batchFinalizeStatement", () => {
    // The booking batch passes the attendee id as a MAX(id) subquery; a direct
    // unit test binds it as a literal `?` and uses a trivially-true guard, so it
    // exercises the UNRESOLVED + guard gating without an in-batch attendee row.
    const trueGuard = { args: [] as never[], sql: "1 = 1" };

    test("sets the attendee and encrypted ticket token on an unresolved reservation", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const attendeeResult = await bookAttendee(listing, {
        email: "fss@example.com",
        name: "Fss",
      });
      if (!attendeeResult.success) throw new Error("setup failed");
      const attendeeId = attendeeResult.attendees[0]!.id;

      await reserveSession("sess_fss");
      await setSessionTicketTokens("sess_fss", ["tok-fss"]);
      const stmt = await batchFinalizeStatement(
        "sess_fss",
        "?",
        attendeeId,
        trueGuard,
        "pi_fss",
      );
      await getDb().execute(stmt);

      const row = await isSessionProcessed("sess_fss");
      expect(row!.attendee_id).toBe(attendeeId);
      expect(row!.payment_reference).not.toContain("pi_fss");
      await expectRefundReferences(attendeeId, ["pi_fss"]);
      expect(row!.ticket_tokens).not.toContain("tok-fss");
      expect(await decryptSessionTokens(row!.ticket_tokens)).toBe("tok-fss");
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
      await finalizeSession("sess_fss2", attendeeId, ["tok-test"]);

      // A second finalize (different attendee id) must not overwrite
      const stmt = await batchFinalizeStatement(
        "sess_fss2",
        "?",
        attendeeId + 999,
        trueGuard,
        "pi_second",
      );
      await getDb().execute(stmt);

      const row = await isSessionProcessed("sess_fss2");
      expect(row!.attendee_id).toBe(attendeeId);
      await expectRefundReferences(attendeeId, ["pi_sess_fss2"]);
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
      const stmt = await batchFinalizeStatement(
        "sess_fss3",
        "?",
        attendeeId,
        {
          args: [],
          sql: "1 = 0",
        },
        "pi_fss3",
      );
      await getDb().execute(stmt);

      const row = await isSessionProcessed("sess_fss3");
      expect(row!.attendee_id).toBe(null);
      expect(row!.payment_reference).toBe("");
    });
  });

  describe("finalizeSessionIfUnresolved", () => {
    test("stamps attendee_id on an unresolved reservation, leaving tokens untouched", async () => {
      await reserveSession("sess_heal");

      await finalizeSessionIfUnresolved("sess_heal", 42);

      const row = (await isSessionProcessed("sess_heal"))!;
      expect(row.attendee_id).toBe(42);
      // The ledger-replay heal never writes ticket_tokens.
      expect(row.ticket_tokens).toBe("");
      expect(row.payment_reference).toBe("");
    });

    test("stores a supplied payment reference on the healed reservation", async () => {
      await reserveSession("sess_heal_reference");

      await finalizeSessionIfUnresolved(
        "sess_heal_reference",
        42,
        "pi_heal_reference",
      );

      await expectRefundReferences(42, ["pi_heal_reference"]);
    });

    test("is a no-op once resolved — preserves a racing delivery's attendee and tokens", async () => {
      await reserveSession("sess_raced");
      // A racing delivery finalizes the row with its own attendee and real tokens.
      await finalizeSession("sess_raced", 7, ["tok-real"]);

      // The replaying delivery tries to heal it to a different attendee; the
      // unresolved guard must make it a no-op so it never clobbers the winner's
      // ticket_tokens (which would render the success page without the ticket).
      await finalizeSessionIfUnresolved("sess_raced", 99);

      const row = (await isSessionProcessed("sess_raced"))!;
      expect(row.attendee_id).toBe(7);
      expect(await decryptSessionTokens(row.ticket_tokens)).toBe("tok-real");
    });

    test("is a no-op if the session was pruned", async () => {
      await finalizeSessionIfUnresolved("sess_gone", 1);
    });
  });

  test("decryptSessionTokens returns an empty string for an empty field", async () => {
    expect(await decryptSessionTokens("")).toBe("");
  });
});
