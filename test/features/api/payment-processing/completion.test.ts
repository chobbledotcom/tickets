import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import { completePaidBooking } from "#routes/api/payment-processing/completion.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { RegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { useFetchStub } from "#test-utils/mocks.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { bookedLine, bookingIntent } from "./index/helpers.ts";

/** What the checkout signed, with no answers and nothing added on top. */
const bareIntent = (): BookingIntent =>
  bookingIntent([{ e: 1, p: 1000, q: 1 }]);

const noPackageFacts = (): RegistrationPackageFacts => ({
  displays: new Map(),
  pricingByGroup: new Map(),
});

/** Raise one pending-notification flag on an attendee, the way a create batch
 * that just committed would have. */
const raiseFlag = async (
  attendeeId: number,
  column: "email_pending" | "webhooks_pending",
): Promise<void> => {
  await execute(`UPDATE attendees SET ${column} = 1 WHERE id = ?`, [
    attendeeId,
  ]);
};

const flagOf = async (
  attendeeId: number,
  column: "email_pending" | "webhooks_pending",
): Promise<number> => {
  const row = await queryOne<{ value: number }>(
    `SELECT ${column} AS value FROM attendees WHERE id = ?`,
    [attendeeId],
  );
  return Number(row?.value ?? 0);
};

describeWithEnv(
  "finishing off a booking that has been paid",
  { db: true },
  () => {
    const fetch = useFetchStub();

    test("hands back the first line's booking, listing, and tickets", async () => {
      const { attendeeId, entry, listingId } = await bookedLine("First Line");

      expect(
        await withRequestContext(() =>
          completePaidBooking(
            [entry],
            bareIntent(),
            ["tok_a", "tok_b"],
            noPackageFacts(),
            undefined,
          ),
        ),
      ).toEqual({
        attendee: { id: attendeeId },
        listingId,
        success: true,
        ticketTokens: ["tok_a", "tok_b"],
      });
    });

    test("sends the confirmation email after the batch committed", async () => {
      const { entry } = await bookedLine("Emailed Line");
      await configureTestEmail({ businessEmail: "owner@example.com" });

      await withRequestContext(() =>
        completePaidBooking(
          [entry],
          bareIntent(),
          [],
          noPackageFacts(),
          undefined,
        ),
      );

      // The buyer's copy and the owner's copy are one send; the entry here
      // carries no decrypted address, so the owner's copy names the target.
      expect(fetch.getFetchJsonBody().to).toEqual(["owner@example.com"]);
    });

    test("clears the pending email flag its send got accepted", async () => {
      const { attendeeId, entry } = await bookedLine("Flagged Line");
      await configureTestEmail({ businessEmail: "owner@example.com" });
      await raiseFlag(attendeeId, "email_pending");

      await withRequestContext(() =>
        completePaidBooking(
          [entry],
          bareIntent(),
          [],
          noPackageFacts(),
          undefined,
        ),
      );

      expect(await flagOf(attendeeId, "email_pending")).toBe(0);
    });

    test("leaves the email flag up when the provider refuses the email", async () => {
      const { attendeeId, entry } = await bookedLine("Refused Line");
      await configureTestEmail({ businessEmail: "owner@example.com" });
      await raiseFlag(attendeeId, "email_pending");
      fetch.restubFetch(() => new Response("", { status: 500 }));

      await withRequestContext(() =>
        completePaidBooking(
          [entry],
          bareIntent(),
          [],
          noPackageFacts(),
          undefined,
        ),
      );

      // The booking stands; only the flag says the email never went out.
      expect(await flagOf(attendeeId, "email_pending")).toBe(1);
    });
  },
);
