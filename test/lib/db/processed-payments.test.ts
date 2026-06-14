import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, insert } from "#shared/db/client.ts";
import {
  finalizeSession as finalizePaymentSession,
  isSessionProcessed,
  reserveSession,
  STALE_RESERVATION_MS,
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
      await finalizePaymentSession("sess_dup", attendeeResult.attendees[0]!.id);

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
          FOREIGN KEY (attendee_id) REFERENCES attendees(id)
        )
      `);
    });
  });
});
