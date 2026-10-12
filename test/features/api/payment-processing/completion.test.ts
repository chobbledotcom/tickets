import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { completePaidBooking } from "#routes/api/payment-processing/completion.ts";
import type { CreatedEntry } from "#routes/api/payment-processing/create.ts";
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

    test("says the checkout was made online", async () => {
      const { entry } = await bookedLine("Online Source Line");
      const notifiedEntry: CreatedEntry = {
        ...entry,
        listing: {
          ...entry.listing,
          webhook_url: "https://example.com/registration",
        },
      };

      await withRequestContext(() =>
        completePaidBooking(
          [notifiedEntry],
          bareIntent(),
          [],
          noPackageFacts(),
          undefined,
        ),
      );

      const webhookCall = Array.from(
        { length: fetch.callCount() },
        (_, index) => fetch.getFetchArgs(index),
      ).find(([url]) => url === "https://example.com/registration");
      const body = JSON.parse(webhookCall![1].body as string) as {
        source: string;
      };
      expect(body.source).toBe("public");
    });
  },
);
