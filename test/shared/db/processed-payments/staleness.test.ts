import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { getDb, insert } from "#shared/db/client.ts";
import {
  deleteAllStaleReservations,
  isReservationStale,
  isSessionProcessed,
  releaseReservation,
  reserveSession,
  STALE_RESERVATION_MS,
} from "#shared/db/processed-payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { useProcessedPaymentsAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { finalizeTestPaymentSession as finalizePaymentSession } from "#test-utils/db-helpers/processed-payments.ts";

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

describeWithEnv("processed-payments / staleness", { db: true }, () => {
  const ctx = useProcessedPaymentsAttendee();
  const now = 2_000_000_000_000;

  describe("isReservationStale", () => {
    test("returns false for a recent timestamp", () => {
      using _time = new FakeTime(now);
      expect(isReservationStale(new Date(now).toISOString())).toBe(false);
    });

    test("returns false at the threshold", () => {
      using _time = new FakeTime(now);
      const threshold = new Date(now - STALE_RESERVATION_MS).toISOString();
      expect(isReservationStale(threshold)).toBe(false);
    });

    test("returns true for a timestamp over the threshold", () => {
      using _time = new FakeTime(now);
      const stale = new Date(now - STALE_RESERVATION_MS - 1).toISOString();
      expect(isReservationStale(stale)).toBe(true);
    });
  });

  describe("releaseReservation", () => {
    test("deletes an unfinalized reservation", async () => {
      await reserveSession("cs_stale_to_delete");
      await releaseReservation("cs_stale_to_delete");
      expect(await isSessionProcessed("cs_stale_to_delete")).toBeNull();
    });

    test("does not delete a finalized reservation", async () => {
      await reserveSession("cs_finalized_no_delete");
      await finalizeSession("cs_finalized_no_delete", ctx.attendeeId, [
        "tok-test",
      ]);
      await releaseReservation("cs_finalized_no_delete");

      const record = await isSessionProcessed("cs_finalized_no_delete");
      expect(record?.attendee_id).toBe(ctx.attendeeId);
    });

    test("is a no-op for a non-existent session", async () => {
      await releaseReservation("cs_nonexistent");
      // No error thrown — verified by reaching here
    });
  });

  describe("deleteAllStaleReservations", () => {
    const insertStale = (sessionId: string) =>
      getDb().execute(
        insert("processed_payments", {
          attendee_id: null,
          payment_session_id: sessionId,
          processed_at: new Date(
            Date.now() - STALE_RESERVATION_MS - 1000,
          ).toISOString(),
        }),
      );

    test("deletes all stale unfinalized reservations", async () => {
      await insertStale("cs_stale_bulk_1");
      await insertStale("cs_stale_bulk_2");

      expect(await deleteAllStaleReservations()).toBe(2);
      expect(await isSessionProcessed("cs_stale_bulk_1")).toBeNull();
      expect(await isSessionProcessed("cs_stale_bulk_2")).toBeNull();
    });

    test("does not delete fresh unfinalized reservations", async () => {
      await reserveSession("cs_fresh_bulk");

      expect(await deleteAllStaleReservations()).toBe(0);
      expect(await isSessionProcessed("cs_fresh_bulk")).not.toBeNull();
    });

    test("does not delete finalized reservations regardless of age", async () => {
      await getDb().execute(
        insert("processed_payments", {
          attendee_id: ctx.attendeeId,
          payment_session_id: "cs_finalized_bulk",
          processed_at: new Date(
            Date.now() - STALE_RESERVATION_MS - 1000,
          ).toISOString(),
        }),
      );

      expect(await deleteAllStaleReservations()).toBe(0);
      expect((await isSessionProcessed("cs_finalized_bulk"))?.attendee_id).toBe(
        ctx.attendeeId,
      );
    });

    test("returns 0 when no stale reservations exist", async () => {
      expect(await deleteAllStaleReservations()).toBe(0);
    });
  });
});
