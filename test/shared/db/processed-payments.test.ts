import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { encrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { getDb, insert } from "#db/client.ts";
import { SCHEMA } from "#db/migrations/schema/index.ts";
import { createTableSql } from "#db/migrations/schema-sync.ts";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import {
  clearSessionTokens,
  decryptSessionTokens,
  encryptTicketTokens,
  finalizeSessionIfUnresolved,
  markSessionFailed,
  parseSessionFailure,
  reserveSession,
  STALE_RESERVATION_MS,
} from "#db/processed-payments.ts";
import {
  type StoredPaymentFailure,
  writeRowState,
} from "#payment/row-state.ts";
import { nowMs } from "#shared/now.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import {
  claimCurrentAttendeeRows,
  referenceIndexOf,
} from "#test-utils/payment-claim.ts";
import {
  bookedWithPayment,
  expectProcessedPaymentReference,
  finalizeReservedPayment,
  getProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

describeWithEnv("db > processed payments", { db: true }, () => {
  describe("reserveSession", () => {
    test("succeeds on first call", async () => {
      const calls = await countDatabaseCalls(1, async () => {
        const result = await reserveSession("sess_test_1");
        expect(result.reserved).toBe(true);
      });
      expect(calls).toBe(1);
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

      const calls = await countDatabaseCalls(1, async () => {
        const result = await reserveSession("sess_dup");
        expect(result.reserved).toBe(false);
        if (!result.reserved) {
          expect(result.existing.attendee_id).toBe(
            attendeeResult.attendees[0]!.id,
          );
        }
      });
      expect(calls).toBe(1);
    });

    test("returns existing when session is reserved but not finalized", async () => {
      await reserveSession("sess_unfinalized");

      const calls = await countDatabaseCalls(1, async () => {
        const result = await reserveSession("sess_unfinalized");
        expect(result.reserved).toBe(false);
        if (!result.reserved) expect(result.existing.attendee_id).toBeNull();
      });
      expect(calls).toBe(1);
    });

    test("claims a stale reservation in one database call", async () => {
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

      const calls = await countDatabaseCalls(1, async () => {
        const result = await reserveSession("sess_stale");
        expect(result.reserved).toBe(true);
      });
      expect(calls).toBe(1);

      // Session was successfully re-reserved and is now tracked
      const processed = await getProcessedPayment("sess_stale");
      expect(processed).not.toBeNull();
    });

    test("records and replays a terminal failure round-trip", async () => {
      await reserveSession("sess_failrt");
      await markSessionFailed("sess_failrt", {
        error: "Sold out",
        refunded: true,
        status: 409,
      });
      const row = await getProcessedPayment("sess_failrt");
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
      const row = await getProcessedPayment("sess_failenc");
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
      const row = await getProcessedPayment("sess_failtwice");
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

      const row = await getProcessedPayment("sess_finalized_nofail");
      // The success is preserved: attendee_id intact, no failure recorded.
      expect(row!.attendee_id).toBe(attendee.attendees[0]!.id);
      expect(row!.failure_data).toBe("");
    });

    test("parseSessionFailure returns null when no failure is recorded", async () => {
      expect(await parseSessionFailure("")).toBeNull();
    });

    test("parseSessionFailure rejects undecryptable stored data", async () => {
      await expect(
        parseSessionFailure("not valid ciphertext{" as EnvKeyEncrypted),
      ).rejects.toThrow();
    });

    test("parseSessionFailure rejects invalid stored fields at their boundary", async () => {
      await expect(
        parseSessionFailure(await encrypt('{"error":42,"refunded":"yes"}')),
      ).rejects.toThrow("processed_payments.failure_data");
    });

    test("parseSessionFailure rejects the obsolete bare failure shape", async () => {
      await expect(
        parseSessionFailure(await encrypt('{"error":"Gone"}')),
      ).rejects.toThrow("processed_payments.failure_data");
    });

    test("parseSessionFailure rejects terminal outcomes mixed with live work", async () => {
      const mixed = writeRowState(
        {
          outcome: { error: "Gone" },
          unrecorded: { returnedAt: "2026-08-13T12:00:00.000Z" },
        },
        "processed_payments.failure_data",
      );
      await expect(parseSessionFailure(await encrypt(mixed))).rejects.toThrow(
        "processed_payments.failure_data: invalid terminal session state",
      );
    });

    test("parseSessionFailure rejects a terminal outcome with a live claim", async () => {
      const mixed = writeRowState(
        {
          claim: {
            attendeeIds: [1],
            commandId: "still-checking",
            phase: "checking",
            scope: "attendee_set",
            writtenAt: "2026-08-14T08:00:00.000Z",
          },
          outcome: { error: "Gone" },
        },
        "processed_payments.failure_data",
      );
      await expect(parseSessionFailure(await encrypt(mixed))).rejects.toThrow(
        "processed_payments.failure_data: invalid terminal session state",
      );
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

      // Rebuild it from the real schema rather than a copy of it. A
      // hand-written CREATE TABLE here silently falls behind every column the
      // app adds, and the next test to use one fails on a missing column.
      const table = SCHEMA.find(([name]) => name === "processed_payments");
      if (table === undefined) {
        throw new Error("Missing processed_payments schema definition");
      }
      await getDb().execute(createTableSql(table));
    });
  });

  test("rethrows the original non-constraint error", async () => {
    const sentinel = new Error("write transport failed");
    const client = getDb();
    using batchStub = stub(client, "batch", () => Promise.reject(sentinel));
    await expect(reserveSession("non-constraint")).rejects.toBe(sentinel);
    expect(batchStub.calls).toHaveLength(1);
  });

  test("throws when the atomic lookup does not return the session", async () => {
    const client = getDb();
    using batchStub = stub(client, "batch", () =>
      Promise.resolve([emptyResultSet(), emptyResultSet()]),
    );
    await expect(reserveSession("missing-lookup")).rejects.toThrow(
      "Reserved payment session is missing: missing-lookup",
    );
    expect(batchStub.calls).toHaveLength(1);
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

      await finalizeSessionIfUnresolved("sess_heal", 42, null);

      const row = (await getProcessedPayment("sess_heal"))!;
      expect(row.attendee_id).toBe(42);
      // The ledger-replay heal never writes ticket_tokens.
      expect(row.ticket_tokens).toBe("");
      expect(row.payment_reference).toBe("");
    });

    test("stores a supplied payment reference while healing", async () => {
      await reserveSession("sess_heal_reference");
      const paymentReference = taggedPaymentReference("pi_healed", "square");
      const calls = await countDatabaseCalls(5, () =>
        finalizeSessionIfUnresolved(
          "sess_heal_reference",
          42,
          paymentReference,
        ),
      );
      expect(calls).toBe(3);
      // Read the stored column before anything else looks at this attendee:
      // the refund read repairs a missing index, so asserting through it would
      // pass whether or not this write put one there.
      expect(await referenceIndexOf("sess_heal_reference")).toBe(
        await paymentReferenceIndex(paymentReference),
      );
      await expectProcessedPaymentReference(
        42,
        "sess_heal_reference",
        paymentReference,
        await getTestPrivateKey(),
      );
    });

    test("refuses to heal an equivalent reference under a refund claim", async () => {
      const reference = "pi_heal_held";
      const attendeeId = await bookedWithPayment("sess_heal_holder", reference);
      const held = await claimCurrentAttendeeRows([attendeeId]);
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      await reserveSession("sess_heal_blocked");

      await expect(
        finalizeSessionIfUnresolved(
          "sess_heal_blocked",
          42,
          taggedPaymentReference(reference),
        ),
      ).rejects.toThrow(
        /^Payment cannot finalize while its reference is held$/u,
      );
      expect(
        (await getProcessedPayment("sess_heal_blocked"))?.attendee_id,
      ).toBe(null);
    });

    test("is a no-op once resolved — preserves a racing delivery's attendee and tokens", async () => {
      await reserveSession("sess_raced");
      // A racing delivery finalizes the row with its own attendee and real tokens.
      await finalizeReservedPayment("sess_raced", 7, "tok-real");

      // The replaying delivery tries to heal it to a different attendee; the
      // unresolved guard must make it a no-op so it never clobbers the winner's
      // ticket_tokens (which would render the success page without the ticket).
      await finalizeSessionIfUnresolved("sess_raced", 99, null);

      const row = (await getProcessedPayment("sess_raced"))!;
      expect(row.attendee_id).toBe(7);
      expect(await decryptSessionTokens(row.ticket_tokens)).toBe("tok-real");
    });

    test("is a no-op if the session was pruned", async () => {
      await finalizeSessionIfUnresolved("sess_gone", 1, null);
    });

    test("clears stored ticket tokens", async () => {
      await reserveSession("sess_clear_tokens");
      await finalizeReservedPayment("sess_clear_tokens", 7, "secret-token");
      await clearSessionTokens("sess_clear_tokens");
      expect(
        (await getProcessedPayment("sess_clear_tokens"))!.ticket_tokens,
      ).toBe("");
    });
  });
});
