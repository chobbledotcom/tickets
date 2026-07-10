import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signMeta } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** Assert every package member's most recent booking landed on `date` and
 *  carries the package's group id — the shared check for a dated package
 *  purchase, whether its per-day prices are plain or customised. */
const expectMembersBookedOnDate = async (
  members: Array<{ id: number }>,
  date: string,
  groupId: number,
): Promise<void> => {
  const { getDb } = await import("#shared/db/client.ts");
  for (const member of members) {
    const row = (
      await getDb().execute({
        args: [member.id],
        sql: "SELECT start_at, package_group_id FROM listing_attendees WHERE listing_id = ? ORDER BY id DESC LIMIT 1",
      })
    ).rows[0]!;
    expect(String(row.start_at).slice(0, 10)).toBe(date);
    expect(Number(row.package_group_id)).toBe(groupId);
  }
};

describeWithEnv("server (payment flow: ticket success)", { db: true }, () => {
  describe("GET /payment/success (ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("processes ticket payment success", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Success Multi 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Success Multi 2",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 2500,
          id: "cs_multi_success",
          metadata: signMeta(
            {
              email: "multi@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 500, q: 1 },
                { e: listing2.id, p: 2000, q: 2 },
              ]),
              name: "Multi Payer",
            },
            2500,
          ),
          payment_intent: "pi_multi_success",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_success"),
        );
        // With multi-listing attendees, one token covers all listings
        expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

        const response = await followRedirect(redirectResponse, handleRequest);
        await expectHtmlResponse(
          response,
          200,
          "Thank you for your order",
          "Click here to view your ticket",
        );

        // Verify attendees created for both listings
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        const attendees2 = await getAttendeesRaw(listing2.id);
        expect(attendees1.length).toBe(1);
        expect(attendees2.length).toBe(1);
        expect(attendees2[0]?.quantity).toBe(2);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("stamps package_group_id on a paid package booking", async () => {
      // The webhook/redirect package path threads intent.packageGroupId onto the
      // created booking rows, so tickets/emails group the order by the persisted
      // id rather than membership equality.
      await setupStripe();
      const { getDb } = await import("#shared/db/client.ts");
      const group = await createTestGroup({
        isPackage: true,
        name: "Paid Kit",
        slug: "paid-kit",
      });
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Paid Member",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_pkg_paid",
          metadata: signMeta(
            {
              email: "pkgpaid@example.com",
              items: JSON.stringify([
                { e: member.id, k: "p", p: 1000, q: 1, r: group.id },
              ]),
              name: "Pkg Payer",
            },
            1000,
          ),
          payment_intent: "pi_pkg_paid",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_pkg_paid"),
        );
        expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

        const row = (
          await getDb().execute({
            args: [member.id],
            sql: "SELECT package_group_id FROM listing_attendees WHERE listing_id = ? ORDER BY id DESC LIMIT 1",
          })
        ).rows[0]!;
        expect(Number(row.package_group_id)).toBe(group.id);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("a paid DAILY package books every member on the signed date", async () => {
      // A dated package rides the order-level `date` metadata; the webhook's
      // tree revalidation must accept the tagged dated lines (no false drift)
      // and persist each member's row on that date.
      await setupStripe();
      const { addDays } = await import("#shared/dates.ts");
      const { todayInTz } = await import("#shared/timezone.ts");
      const group = await createTestGroup({
        isPackage: true,
        name: "Dated Kit",
        slug: "dated-kit",
      });
      const boat = await createTestListing({
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 50,
        minimumDaysBefore: 0,
        name: "Dated Boat",
        unitPrice: 700,
      });
      const hut = await createTestListing({
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 50,
        minimumDaysBefore: 0,
        name: "Dated Hut",
        unitPrice: 300,
      });
      const date = addDays(todayInTz("UTC"), 2);

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_pkg_dated",
          metadata: signMeta(
            {
              date,
              email: "dated@example.com",
              items: JSON.stringify([
                { e: boat.id, k: "p", p: 700, q: 1, r: group.id },
                { e: hut.id, k: "p", p: 300, q: 1, r: group.id },
              ]),
              name: "Dated Payer",
            },
            1000,
          ),
          payment_intent: "pi_pkg_dated",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_pkg_dated"),
        );
        expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

        await expectMembersBookedOnDate([boat, hut], date, group.id);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("a paid CUSTOMISABLE package revalidates per-day overrides for the signed day count", async () => {
      // The boat's 2-day price is overridden inside this package (1000, not its
      // own 1200); the hut keeps its own 2-day price. The webhook's
      // expectedItemPrice must re-derive both from CURRENT config — a mismatch
      // would refund instead of booking.
      await setupStripe();
      const { addDays } = await import("#shared/dates.ts");
      const { todayInTz } = await import("#shared/timezone.ts");
      const { setGroupPackageMembers } = await import("#shared/db/groups.ts");
      const group = await createTestGroup({
        isPackage: true,
        name: "Flex Paid Kit",
        slug: "flex-paid-kit",
      });
      const boat = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 700, 2: 1200 },
        durationDays: 2,
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 50,
        minimumDaysBefore: 0,
        name: "Flex Paid Boat",
        unitPrice: 700,
      });
      const hut = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 500, 2: 900 },
        durationDays: 2,
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 50,
        minimumDaysBefore: 0,
        name: "Flex Paid Hut",
        unitPrice: 500,
      });
      await setGroupPackageMembers(group.id, [
        { dayPrices: { 2: 1000 }, listingId: boat.id, price: null },
        { listingId: hut.id, price: null },
      ]);
      const date = addDays(todayInTz("UTC"), 2);

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1900,
          id: "cs_pkg_flex_paid",
          metadata: signMeta(
            {
              date,
              day_count: "2",
              email: "flexpaid@example.com",
              items: JSON.stringify([
                { e: boat.id, k: "p", p: 1000, q: 1, r: group.id },
                { e: hut.id, k: "p", p: 900, q: 1, r: group.id },
              ]),
              name: "Flex Payer",
            },
            1900,
          ),
          payment_intent: "pi_pkg_flex_paid",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_pkg_flex_paid"),
        );
        expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

        await expectMembersBookedOnDate([boat, hut], date, group.id);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("returns error for invalid ticket metadata", async () => {
      await setupStripe();

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_bad_multi",
          metadata: {
            email: "bad@example.com",

            items: "not-an-array",
            name: "Bad",
          },
          payment_intent: "pi_bad",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_bad_multi"),
        );
        // No valid proof (unsigned, and the items don't parse) → ignored.
        await expectHtmlResponse(response, 400, "not recognized");
      } finally {
        mockRetrieve.restore();
      }
    });
  });
});
