import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  getProcessedAttendeeId,
  isSessionProcessed,
  markSessionProcessed,
} from "#lib/db/processed-payments.ts";
import { createTestDb, resetDb } from "#test-utils";

describe("processed-payments", () => {
  beforeEach(async () => {
    await createTestDb();
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
      await markSessionProcessed("cs_processed_123", 42);

      const result = await isSessionProcessed("cs_processed_123");
      expect(result).not.toBeNull();
      expect(result?.stripe_session_id).toBe("cs_processed_123");
      expect(result?.attendee_id).toBe(42);
      expect(result?.processed_at).toBeDefined();
    });
  });

  describe("markSessionProcessed", () => {
    test("returns true for first processing", async () => {
      const result = await markSessionProcessed("cs_new_session", 1);
      expect(result).toBe(true);
    });

    test("returns false for duplicate processing", async () => {
      // First attempt should succeed
      const first = await markSessionProcessed("cs_duplicate", 1);
      expect(first).toBe(true);

      // Second attempt with same session ID should fail
      const second = await markSessionProcessed("cs_duplicate", 2);
      expect(second).toBe(false);
    });

    test("stores correct attendee ID", async () => {
      await markSessionProcessed("cs_attendee_test", 99);

      const record = await isSessionProcessed("cs_attendee_test");
      expect(record?.attendee_id).toBe(99);
    });

    test("stores ISO timestamp", async () => {
      const before = new Date().toISOString();
      await markSessionProcessed("cs_timestamp_test", 1);
      const after = new Date().toISOString();

      const record = await isSessionProcessed("cs_timestamp_test");
      expect(record?.processed_at).toBeDefined();
      // Timestamp should be between before and after
      expect(record?.processed_at >= before).toBe(true);
      expect(record?.processed_at <= after).toBe(true);
    });
  });

  describe("getProcessedAttendeeId", () => {
    test("returns null for unprocessed session", async () => {
      const result = await getProcessedAttendeeId("cs_never_processed");
      expect(result).toBeNull();
    });

    test("returns attendee ID for processed session", async () => {
      await markSessionProcessed("cs_with_attendee", 123);

      const result = await getProcessedAttendeeId("cs_with_attendee");
      expect(result).toBe(123);
    });
  });

  describe("idempotency", () => {
    test("multiple concurrent processing attempts only create one record", async () => {
      const sessionId = "cs_concurrent";

      // Simulate concurrent attempts
      const results = await Promise.all([
        markSessionProcessed(sessionId, 1),
        markSessionProcessed(sessionId, 2),
        markSessionProcessed(sessionId, 3),
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
