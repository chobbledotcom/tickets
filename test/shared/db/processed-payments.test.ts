import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { getDb, insert } from "#shared/db/client.ts";
import {
  clearSessionTokens,
  decryptSessionTokens,
  encryptTicketTokens,
  finalizeSessionIfUnresolved,
  isSessionProcessed,
  isUnresolvedReservation,
  markSessionFailed,
  parseSessionFailure,
  reserveSession,
  STALE_RESERVATION_MS,
  type StoredPaymentFailure,
} from "#shared/db/processed-payments.ts";
import { nowMs } from "#shared/now.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  expectProcessedPaymentReference,
  finalizeReservedPayment,
} from "#test-utils/processed-payments.ts";

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
      await finalizeReservedPayment(
        "sess_dup",
        attendeeResult.attendees[0]!.id,
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
      await finalizeReservedPayment(
        "sess_finalized_nofail",
        attendee.attendees[0]!.id,
        "tok-test",
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

    test("parseSessionFailure degrades invalid JSON fields to a terminal failure", async () => {
      const result = await parseSessionFailure(
        await encrypt('{"error":42,"refunded":"yes"}'),
      );
      expect(result).toEqual({
        error: "This payment could not be completed. Please contact support.",
        status: 500,
      });
    });

    test("markSessionFailed throws a labelled error for an invalid failure", async () => {
      await expect(
        markSessionFailed("sess_invalid", {
          error: 42 as unknown as string,
        } as StoredPaymentFailure),
      ).rejects.toThrow("processed_payments.failure_data");
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
          payment_reference TEXT NOT NULL DEFAULT '',
          provider_refunded_at TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (attendee_id) REFERENCES attendees(id)
        )
      `);
    });
  });

  test("distinguishes unresolved rows from both terminal outcomes", () => {
    const base = {
      failure_data: "" as const,
      payment_reference: "" as const,
      payment_session_id: "state-shape",
      processed_at: "2026-07-18T00:00:00.000Z",
      provider_refunded_at: "",
      ticket_tokens: "" as const,
    };
    expect(isUnresolvedReservation({ ...base, attendee_id: null })).toBe(true);
    expect(isUnresolvedReservation({ ...base, attendee_id: 1 })).toBe(false);
    expect(
      isUnresolvedReservation({
        ...base,
        attendee_id: null,
        failure_data: "encrypted" as EnvKeyEncrypted,
      }),
    ).toBe(false);
  });

  test("rethrows the original non-constraint error", async () => {
    const sentinel = new Error("write transport failed");
    const client = getDb();
    const original = client.execute.bind(client);
    let first = true;
    using executeStub = stub(client, "execute", (...args) => {
      if (first) {
        first = false;
        return Promise.reject(sentinel);
      }
      return original(...args);
    });
    await expect(reserveSession("non-constraint")).rejects.toBe(sentinel);
    expect(executeStub.calls).toHaveLength(1);
  });

  test("encrypts multiple ticket tokens with their separator", async () => {
    expect(
      await decryptSessionTokens(await encryptTicketTokens(["one", "two"])),
    ).toBe("one+two");
  });

  test("returns an exact empty token value without decrypting", async () => {
    expect(await decryptSessionTokens("")).toBe("");
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

    test("stores a supplied payment reference while healing", async () => {
      await reserveSession("sess_heal_reference");
      await finalizeSessionIfUnresolved("sess_heal_reference", 42, "pi_healed");
      await expectProcessedPaymentReference(
        42,
        "sess_heal_reference",
        "pi_healed",
        await getTestPrivateKey(),
      );
    });

    test("is a no-op once resolved — preserves a racing delivery's attendee and tokens", async () => {
      await reserveSession("sess_raced");
      // A racing delivery finalizes the row with its own attendee and real tokens.
      await finalizeReservedPayment("sess_raced", 7, "tok-real");

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

    test("clears stored ticket tokens", async () => {
      await reserveSession("sess_clear_tokens");
      await finalizeReservedPayment("sess_clear_tokens", 7, "secret-token");
      await clearSessionTokens("sess_clear_tokens");
      expect(
        (await isSessionProcessed("sess_clear_tokens"))!.ticket_tokens,
      ).toBe("");
    });
  });
});
