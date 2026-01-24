import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  getProcessedAttendeeId,
  isSessionProcessed,
  markSessionProcessed,
} from "#lib/db/processed-payments.ts";
import {
  createAttendee,
  createTestDbWithSetup,
  createTestEvent,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

describe("processed-payments", () => {
  let testAttendeeId: number;
  let testAttendeeId2: number;
  let testAttendeeId3: number;

  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
    // Create test event and attendees to satisfy foreign key constraints
    const event = await createTestEvent();
    const attendee1 = await createAttendee(event.id, "Test User 1", "test1@example.com");
    const attendee2 = await createAttendee(event.id, "Test User 2", "test2@example.com");
    const attendee3 = await createAttendee(event.id, "Test User 3", "test3@example.com");
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
      await markSessionProcessed("cs_processed_123", testAttendeeId);

      const result = await isSessionProcessed("cs_processed_123");
      expect(result).not.toBeNull();
      expect(result?.stripe_session_id).toBe("cs_processed_123");
      expect(result?.attendee_id).toBe(testAttendeeId);
      expect(result?.processed_at).toBeDefined();
    });
  });

  describe("markSessionProcessed", () => {
    test("returns true for first processing", async () => {
      const result = await markSessionProcessed("cs_new_session", testAttendeeId);
      expect(result).toBe(true);
    });

    test("returns false for duplicate processing", async () => {
      // First attempt should succeed
      const first = await markSessionProcessed("cs_duplicate", testAttendeeId);
      expect(first).toBe(true);

      // Second attempt with same session ID should fail
      const second = await markSessionProcessed("cs_duplicate", testAttendeeId2);
      expect(second).toBe(false);
    });

    test("stores correct attendee ID", async () => {
      await markSessionProcessed("cs_attendee_test", testAttendeeId);

      const record = await isSessionProcessed("cs_attendee_test");
      expect(record?.attendee_id).toBe(testAttendeeId);
    });

    test("stores ISO timestamp", async () => {
      const before = new Date().toISOString();
      await markSessionProcessed("cs_timestamp_test", testAttendeeId);
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

    test("returns attendee ID for processed session", async () => {
      await markSessionProcessed("cs_with_attendee", testAttendeeId);

      const result = await getProcessedAttendeeId("cs_with_attendee");
      expect(result).toBe(testAttendeeId);
    });
  });

  describe("idempotency", () => {
    test("multiple concurrent processing attempts only create one record", async () => {
      const sessionId = "cs_concurrent";

      // Simulate concurrent attempts with different attendees
      const results = await Promise.all([
        markSessionProcessed(sessionId, testAttendeeId),
        markSessionProcessed(sessionId, testAttendeeId2),
        markSessionProcessed(sessionId, testAttendeeId3),
      ]);

      // Only one should succeed
      const successes = results.filter(Boolean);
      expect(successes.length).toBe(1);

      // The record should exist
      const record = await isSessionProcessed(sessionId);
      expect(record).not.toBeNull();
    });
  });
});
