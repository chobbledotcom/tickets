// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, insert } from "#shared/db/client.ts";
import { deleteAllStaleReservations } from "#shared/db/processed-payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv(
  "server listings > stale reservation cleanup",
  { db: true },
  () => {
    describe("stale reservation cleanup", () => {
      test("cleans up stale reservations but keeps fresh ones", async () => {
        await setupListingAndLogin({
          maxAttendees: 100,
          name: "Cleanup Test Listing",
          thankYouUrl: "https://example.com",
        });

        // A stale reservation (older than 5 minutes) alongside a fresh one.
        const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
        await getDb().execute(
          insert("processed_payments", {
            attendee_id: null,
            payment_session_id: "cs_stale_admin_test",
            processed_at: staleTime,
          }),
        );
        await getDb().execute(
          insert("processed_payments", {
            attendee_id: null,
            payment_session_id: "cs_fresh_cleanup_test",
            processed_at: new Date().toISOString(),
          }),
        );

        const staleRows = async (id: string) =>
          (
            await getDb().execute({
              args: [id],
              sql: `SELECT *
                  FROM processed_payments
                  WHERE payment_session_id = ?`,
            })
          ).rows.length;

        expect(await staleRows("cs_stale_admin_test")).toBe(1);

        // The reservation-cleanup routine drops the abandoned (stale) checkout
        // while leaving the in-progress fresh one untouched.
        const removed = await deleteAllStaleReservations();
        expect(removed).toBeGreaterThanOrEqual(1);
        expect(await staleRows("cs_stale_admin_test")).toBe(0);
        expect(await staleRows("cs_fresh_cleanup_test")).toBe(1);
      });

      test("does not clean up fresh reservations when viewing an listing", async () => {
        const { listing, cookie } = await setupListingAndLogin({
          maxAttendees: 100,
          name: "Fresh Reservation Test",
          thankYouUrl: "https://example.com",
        });

        // Insert a fresh reservation (just now)
        await getDb().execute(
          insert("processed_payments", {
            attendee_id: null,
            payment_session_id: "cs_fresh_admin_test",
            processed_at: new Date().toISOString(),
          }),
        );

        // View the admin listing page
        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}`,
          {
            cookie,
          },
        );
        expect(response.status).toBe(200);

        // Fresh reservation should still exist
        const after = await getDb().execute({
          args: ["cs_fresh_admin_test"],
          sql: `SELECT *
              FROM processed_payments
              WHERE payment_session_id = ?`,
        });
        expect(after.rows.length).toBe(1);
      });
    });
  },
);
