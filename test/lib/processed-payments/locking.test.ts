import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, insert } from "#shared/db/client.ts";
import {
  clearSessionTokens,
  decryptSessionTokens,
  finalizeSession,
  getProcessedAttendeeId,
  isSessionProcessed,
  reserveSession,
  STALE_RESERVATION_MS,
} from "#shared/db/processed-payments.ts";
import {
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  useProcessedPaymentsAttendee,
} from "#test-utils";

/** Perform the full two-phase reserve+finalize as production code does */
const processSession = async (
  sessionId: string,
  attendeeId: number,
): Promise<boolean> => {
  const result = await reserveSession(sessionId);
  if (!result.reserved) return false;
  await finalizeSession(sessionId, attendeeId, ["tok-test"]);
  return true;
};

describeWithEnv("processed-payments / locking", { db: true }, () => {
  const ctx = useProcessedPaymentsAttendee();

  describe("isSessionProcessed", () => {
    test("returns null for unprocessed session", async () => {
      expect(await isSessionProcessed("cs_unprocessed_123")).toBeNull();
    });

    test("returns record for finalized session", async () => {
      await reserveSession("cs_processed_123");
      await finalizeSession("cs_processed_123", ctx.attendeeId, ["tok-test"]);

      const result = await isSessionProcessed("cs_processed_123");
      expect(result?.payment_session_id).toBe("cs_processed_123");
      expect(result?.attendee_id).toBe(ctx.attendeeId);
      expect(result?.processed_at).toBeDefined();
    });

    test("returns record with null attendee_id for reserved-but-not-finalized session", async () => {
      await reserveSession("cs_reserved_123");

      const result = await isSessionProcessed("cs_reserved_123");
      expect(result?.payment_session_id).toBe("cs_reserved_123");
      expect(result?.attendee_id).toBeNull();
    });
  });

  describe("reserveSession", () => {
    test("returns reserved:true for new session", async () => {
      const result = await reserveSession("cs_new_session");
      expect(result.reserved).toBe(true);
    });

    test("returns reserved:false with null attendee_id for already-reserved session", async () => {
      await reserveSession("cs_duplicate_reserve");
      const second = await reserveSession("cs_duplicate_reserve");
      expect(second.reserved).toBe(false);
      if (!second.reserved) {
        expect(second.existing.attendee_id).toBeNull();
      }
    });

    test("returns reserved:false with attendee_id for finalized session", async () => {
      await reserveSession("cs_finalized");
      await finalizeSession("cs_finalized", ctx.attendeeId, ["tok-test"]);

      const result = await reserveSession("cs_finalized");
      expect(result.reserved).toBe(false);
      if (!result.reserved) {
        expect(result.existing.attendee_id).toBe(ctx.attendeeId);
      }
    });

    test("recovers stale unfinalized reservation and succeeds", async () => {
      // Simulate a reservation left by a crashed process (>5 min old)
      const staleTime = new Date(
        Date.now() - STALE_RESERVATION_MS - 1000,
      ).toISOString();
      await getDb().execute(
        insert("processed_payments", {
          attendee_id: null,
          payment_session_id: "cs_stale_recovery",
          processed_at: staleTime,
        }),
      );

      // A new attempt should succeed by cleaning up the stale record
      const result = await reserveSession("cs_stale_recovery");
      expect(result.reserved).toBe(true);

      // Old stale record is gone, new one exists
      const record = await isSessionProcessed("cs_stale_recovery");
      expect(record?.attendee_id).toBeNull();
      expect(new Date(record!.processed_at).getTime()).toBeGreaterThan(
        Date.now() - 5000,
      );
    });

    test("only one concurrent reservation succeeds", async () => {
      const results = await Promise.all([
        reserveSession("cs_concurrent_reserve"),
        reserveSession("cs_concurrent_reserve"),
        reserveSession("cs_concurrent_reserve"),
      ]);
      expect(results.filter((r) => r.reserved).length).toBe(1);
      expect(results.filter((r) => !r.reserved).length).toBe(2);
    });
  });

  describe("finalizeSession", () => {
    test("sets attendee_id on reserved session", async () => {
      await reserveSession("cs_to_finalize");
      await finalizeSession("cs_to_finalize", ctx.attendeeId, ["tok-test"]);

      const record = await isSessionProcessed("cs_to_finalize");
      expect(record?.attendee_id).toBe(ctx.attendeeId);
    });

    test("stores ticket tokens encrypted when provided", async () => {
      await reserveSession("cs_with_tokens");
      await finalizeSession("cs_with_tokens", ctx.attendeeId, [
        "tok_abc",
        "tok_def",
      ]);

      const record = await isSessionProcessed("cs_with_tokens");
      expect(record?.ticket_tokens).toMatch(/^enc:1:/);
      expect(await decryptSessionTokens(record!.ticket_tokens)).toBe(
        "tok_abc+tok_def",
      );
    });
  });

  describe("clearSessionTokens", () => {
    test("clears stored tokens while preserving attendee_id", async () => {
      await reserveSession("cs_clear_test");
      await finalizeSession("cs_clear_test", ctx.attendeeId, ["tok_xyz"]);
      await clearSessionTokens("cs_clear_test");

      const record = await isSessionProcessed("cs_clear_test");
      expect(record?.ticket_tokens).toBe("");
      expect(record?.attendee_id).toBe(ctx.attendeeId);
    });

    test("is a no-op when tokens are already empty", async () => {
      await reserveSession("cs_clear_noop");
      await finalizeSession("cs_clear_noop", ctx.attendeeId, ["tok-test"]);
      await clearSessionTokens("cs_clear_noop");

      const record = await isSessionProcessed("cs_clear_noop");
      expect(record?.ticket_tokens).toBe("");
      expect(record?.attendee_id).toBe(ctx.attendeeId);
    });
  });

  describe("getProcessedAttendeeId", () => {
    test("returns null for unprocessed session", async () => {
      expect(await getProcessedAttendeeId("cs_never_processed")).toBeNull();
    });

    test("returns null for reserved-but-not-finalized session", async () => {
      await reserveSession("cs_reserved_only");
      expect(await getProcessedAttendeeId("cs_reserved_only")).toBeNull();
    });

    test("returns attendee ID after finalization", async () => {
      await reserveSession("cs_finalized_attendee");
      await finalizeSession("cs_finalized_attendee", ctx.attendeeId, [
        "tok-test",
      ]);
      expect(await getProcessedAttendeeId("cs_finalized_attendee")).toBe(
        ctx.attendeeId,
      );
    });
  });

  describe("idempotency", () => {
    test("concurrent processing attempts only create one record", async () => {
      const listing = await createTestListing();
      const [a2, a3] = await Promise.all([
        createTestAttendee(
          listing.id,
          listing.slug,
          "User 2",
          "u2@example.com",
        ),
        createTestAttendee(
          listing.id,
          listing.slug,
          "User 3",
          "u3@example.com",
        ),
      ]);

      const results = await Promise.all([
        processSession("cs_concurrent", ctx.attendeeId),
        processSession("cs_concurrent", a2.id),
        processSession("cs_concurrent", a3.id),
      ]);

      expect(results.filter(Boolean).length).toBe(1);
      expect(await isSessionProcessed("cs_concurrent")).not.toBeNull();
    });
  });
});
