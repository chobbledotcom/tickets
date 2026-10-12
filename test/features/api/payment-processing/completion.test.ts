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

/** The entry as the create batch hands it on: the in-memory echo carries the
 *  buyer's typed address, which the raw stored row the fixture reads back
 *  does not. */
const withBuyerAddress = (
  entry: Parameters<typeof completePaidBooking>[0][number],
  email: string,
): typeof entry => ({ ...entry, attendee: { ...entry.attendee, email } });

describeWithEnv(
  "finishing off a booking that has been paid",
  { db: true },
  () => {
    const fetch = useFetchStub();

    /** Book one flagged line, run the paid-completion send against the
     *  stubbed provider, and return the email flag the row carries after.
     *  `mapEntry` reshapes the entry the way the caller's scenario needs. */
    const completedEmailFlag = async (
      name: string,
      {
        mapEntry,
        providerStatus = 200,
      }: {
        mapEntry?: (
          entry: Parameters<typeof withBuyerAddress>[0],
        ) => typeof entry;
        providerStatus?: number;
      } = {},
    ): Promise<number> => {
      const { attendeeId, entry } = await bookedLine(name);
      await configureTestEmail({ businessEmail: "owner@example.com" });
      await raiseFlag(attendeeId, "email_pending");
      if (providerStatus !== 200) {
        fetch.restubFetch(() => new Response("", { status: providerStatus }));
      }
      await withRequestContext(() =>
        completePaidBooking(
          [mapEntry ? mapEntry(entry) : entry],
          bareIntent(),
          [],
          noPackageFacts(),
          undefined,
        ),
      );
      return flagOf(attendeeId, "email_pending");
    };

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
      // The create batch's echo carries the buyer's typed address (see the
      // attendee it hands back), so the confirmation goes to the buyer. That
      // is the send this flag tracks.
      expect(
        await completedEmailFlag("Flagged Line", {
          mapEntry: (entry) =>
            withBuyerAddress(entry, "flagged-buyer@example.com"),
        }),
      ).toBe(0);
    });

    test("an owner-only copy leaves the pending email flag up", async () => {
      // No buyer address on the entry, so the send delivers the owner's
      // admin copy alone. The owner's copy is accepted, but the buyer's
      // confirmation never went out: the flag stays up.
      expect(await completedEmailFlag("Owner Copy Line")).toBe(1);
    });

    test("leaves the email flag up when the provider refuses the email", async () => {
      // The booking stands; only the flag says the email never went out.
      expect(
        await completedEmailFlag("Refused Line", { providerStatus: 500 }),
      ).toBe(1);
    });
  },
);
