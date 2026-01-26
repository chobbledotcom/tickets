import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  finalizeSession,
  getProcessedAttendeeId,
  isSessionProcessed,
  reserveSession,
} from "#lib/db/processed-payments.ts";
import {
  createTestAttendee,
  createTestDbWithSetup,
  createTestEvent,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

/** Helper to simulate the old markSessionProcessed behavior using two-phase locking */
const processSession = async (sessionId: string, attendeeId: number): Promise<boolean> => {
  const result = await reserveSession(sessionId);
  if (!result.reserved) {
    return false;
  }
  await finalizeSession(sessionId, attendeeId);
  return true;
};

describe("processed-payments", () => {
  let testAttendeeId: number;
  let testAttendeeId2: number;
  let testAttendeeId3: number;

  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
    // Create test event and attendees to satisfy foreign key constraints
    const event = await createTestEvent();
    const attendee1 = await createTestAttendee(event.id, event.slug, "Test User 1", "test1@example.com");
    const attendee2 = await createTestAttendee(event.id, event.slug, "Test User 2", "test2@example.com");
    const attendee3 = await createTestAttendee(event.id, event.slug, "Test User 3", "test3@example.com");
    testAttendeeId = attendee1.id;
    testAttendeeId2 = attendee2.id;
    testAttendeeId3 = attendee3.id;
  });

  afterEach(() => {
    resetDb();
  });

  describe("isSessionProcessed", () => {
    test("returns null for unprocessed session", async () => {
      const result = await isSessionProcessed("cs_unprocessed_123");
      expect(result).toBeNull();
    });

    test("returns record for processed session", async () => {
      await processSession("cs_processed_123", testAttendeeId);

      const result = await isSessionProcessed("cs_processed_123");
      expect(result).not.toBeNull();
      expect(result?.stripe_session_id).toBe("cs_processed_123");
      expect(result?.attendee_id).toBe(testAttendeeId);
      expect(result?.processed_at).toBeDefined();
    });

    test("returns record with null attendee_id for reserved session", async () => {
      await reserveSession("cs_reserved_123");

      const result = await isSessionProcessed("cs_reserved_123");
      expect(result).not.toBeNull();
      expect(result?.stripe_session_id).toBe("cs_reserved_123");
      expect(result?.attendee_id).toBeNull();
      expect(result?.processed_at).toBeDefined();
    });
  });

  describe("reserveSession", () => {
    test("returns reserved:true for new session", async () => {
      const result = await reserveSession("cs_new_session");
      expect(result.reserved).toBe(true);
    });

    test("returns reserved:false with existing record for already reserved session", async () => {
      // First reservation
      const first = await reserveSession("cs_duplicate_reserve");
      expect(first.reserved).toBe(true);

      // Second attempt
      const second = await reserveSession("cs_duplicate_reserve");
      expect(second.reserved).toBe(false);
      if (!second.reserved) {
        expect(second.existing.stripe_session_id).toBe("cs_duplicate_reserve");
        expect(second.existing.attendee_id).toBeNull();
      }
    });

    test("returns reserved:false with attendee_id for finalized session", async () => {
      // Reserve and finalize
      await reserveSession("cs_finalized");
      await finalizeSession("cs_finalized", testAttendeeId);

      // Try to reserve again
      const result = await reserveSession("cs_finalized");
      expect(result.reserved).toBe(false);
      if (!result.reserved) {
        expect(result.existing.attendee_id).toBe(testAttendeeId);
      }
    });

    test("concurrent reservations only one succeeds", async () => {
      const sessionId = "cs_concurrent_reserve";

      // Simulate concurrent attempts
      const results = await Promise.all([
        reserveSession(sessionId),
        reserveSession(sessionId),
        reserveSession(sessionId),
      ]);

      // Only one should succeed
      const successes = results.filter((r) => r.reserved);
      expect(successes.length).toBe(1);

      // Others should see the existing record
      const failures = results.filter((r) => !r.reserved);
      expect(failures.length).toBe(2);
      for (const failure of failures) {
        if (!failure.reserved) {
          expect(failure.existing.stripe_session_id).toBe(sessionId);
        }
      }
    });
  });

  describe("finalizeSession", () => {
    test("updates attendee_id on reserved session", async () => {
      await reserveSession("cs_to_finalize");

      // Verify attendee_id is null
      let record = await isSessionProcessed("cs_to_finalize");
      expect(record?.attendee_id).toBeNull();

      // Finalize
      await finalizeSession("cs_to_finalize", testAttendeeId);

      // Verify attendee_id is set
      record = await isSessionProcessed("cs_to_finalize");
      expect(record?.attendee_id).toBe(testAttendeeId);
    });
  });

  describe("two-phase session processing", () => {
    test("returns true for first processing", async () => {
      const result = await processSession("cs_new_session_process", testAttendeeId);
      expect(result).toBe(true);
    });

    test("returns false for duplicate processing", async () => {
      // First attempt should succeed
      const first = await processSession("cs_duplicate_process", testAttendeeId);
      expect(first).toBe(true);

      // Second attempt with same session ID should fail
      const second = await processSession("cs_duplicate_process", testAttendeeId2);
      expect(second).toBe(false);
    });

    test("stores correct attendee ID", async () => {
      await processSession("cs_attendee_test", testAttendeeId);

      const record = await isSessionProcessed("cs_attendee_test");
      expect(record?.attendee_id).toBe(testAttendeeId);
    });

    test("stores ISO timestamp", async () => {
      const before = new Date().toISOString();
      await processSession("cs_timestamp_test", testAttendeeId);
      const after = new Date().toISOString();

      const record = await isSessionProcessed("cs_timestamp_test");
      expect(record).not.toBeNull();
      expect(record?.processed_at).toBeDefined();
      // Timestamp should be between before and after
      const processedAt = record?.processed_at ?? "";
      expect(processedAt >= before).toBe(true);
      expect(processedAt <= after).toBe(true);
    });
  });

  describe("getProcessedAttendeeId", () => {
    test("returns null for unprocessed session", async () => {
      const result = await getProcessedAttendeeId("cs_never_processed");
      expect(result).toBeNull();
    });

    test("returns null for reserved but not finalized session", async () => {
      await reserveSession("cs_reserved_only");

      const result = await getProcessedAttendeeId("cs_reserved_only");
      expect(result).toBeNull();
    });

    test("returns attendee ID for processed session", async () => {
      await processSession("cs_with_attendee", testAttendeeId);

      const result = await getProcessedAttendeeId("cs_with_attendee");
      expect(result).toBe(testAttendeeId);
    });

    test("returns attendee ID for finalized session", async () => {
      await reserveSession("cs_finalized_attendee");
      await finalizeSession("cs_finalized_attendee", testAttendeeId);

      const result = await getProcessedAttendeeId("cs_finalized_attendee");
      expect(result).toBe(testAttendeeId);
    });
  });

  describe("idempotency", () => {
    test("multiple concurrent processing attempts only create one record", async () => {
      const sessionId = "cs_concurrent";

      // Simulate concurrent attempts with different attendees
      const results = await Promise.all([
        processSession(sessionId, testAttendeeId),
        processSession(sessionId, testAttendeeId2),
        processSession(sessionId, testAttendeeId3),
      ]);

      // Only one should succeed
      const successes = results.filter(Boolean);
      expect(successes.length).toBe(1);

      // The record should exist
      const record = await isSessionProcessed(sessionId);
      expect(record).not.toBeNull();
    });

    test("two-phase locking prevents duplicate attendee creation", async () => {
      const sessionId = "cs_two_phase_test";

      // Simulate the race condition scenario:
      // Request A reserves, Request B tries to reserve
      const reserveA = await reserveSession(sessionId);
      expect(reserveA.reserved).toBe(true);

      const reserveB = await reserveSession(sessionId);
      expect(reserveB.reserved).toBe(false);
      if (!reserveB.reserved) {
        // B sees that A has reserved but not finalized
        expect(reserveB.existing.attendee_id).toBeNull();
      }

      // A finalizes with attendee
      await finalizeSession(sessionId, testAttendeeId);

      // Now if C tries to reserve, they see the finalized attendee
      const reserveC = await reserveSession(sessionId);
      expect(reserveC.reserved).toBe(false);
      if (!reserveC.reserved) {
        expect(reserveC.existing.attendee_id).toBe(testAttendeeId);
      }
    });
  });
});
