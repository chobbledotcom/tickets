/**
 * Tests for how a package's rows collapse onto the ticket page at GET /t/:tokens
 *
 * Sits beside the story `@story:attendees.the-ticket-a-customer-holds`, whose
 * bundle rule owns what a buyer sees. These own the arrangements no customer
 * journey can reach or prove: rows an operator's edit or an attendee merge
 * leaves behind, the (token, package) bucketing that keeps two buyers apart on
 * one link, the date arithmetic behind a dated package card, and the stored
 * package id the public free checkout must stamp.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { getDb } from "#db/client.ts";
import { groups } from "#db/groups.ts";
import { addDays, formatDateRangeLabelCompactEn } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { submitPackageBooking } from "#test-utils/packages.ts";

// jscpd:ignore-end

/** Fetch a ticket page and return the response body text. */
const fetchTicketBody = async (tokenPath: string): Promise<string> => {
  const response = await awaitTestRequest(`/t/${tokenPath}`);
  return response.text();
};

/** Book these lines as one order and return the ticket page they lead to. */
const ticketBodyForBooking = async (
  bookings: Parameters<typeof attendeesApi.createAttendeeAtomic>[0]["bookings"],
  who: string,
): Promise<string> => {
  const token = await bookedToken(bookings, who);
  return fetchTicketBody(token);
};

/** Book these lines as one order and return the code that order carries. */
const bookedToken = async (
  bookings: Parameters<typeof attendeesApi.createAttendeeAtomic>[0]["bookings"],
  who: string,
): Promise<string> => {
  const result = await attendeesApi.createAttendeeAtomic({
    bookings,
    email: `${who}@test.com`,
    name: who,
  });
  if (!result.success) throw new Error(`Booking failed for ${who}`);
  return result.attendees[0]!.ticket_token;
};

/** A private one-member package and its sole listing. */
const hiddenOneMemberPackage = async () => {
  const group = await createTestGroup({ isPackage: true, name: "Kit Bag" });
  await groups.table.update(group.id, { hidePackageListings: true });
  const widget = await createTestListing({
    groupId: group.id,
    name: "Widget",
  });
  return { group, widget };
};

describeWithEnv("ticket view package grouping", { db: true }, () => {
  describe("rows a customer journey cannot produce", () => {
    test("leaves a standalone row of a private package's listing uncollapsed", async () => {
      // A private package's member has no public page, so only an operator's
      // own booking can carry the member with no package id on its row. That
      // row is not a package purchase and must render as itself rather than
      // being renamed to the package that conceals it.
      const { widget } = await hiddenOneMemberPackage();

      const body = await ticketBodyForBooking(
        [{ listingId: widget.id, quantity: 1 }],
        "standalone",
      );
      expect(body).toContain("Widget");
      expect(body).not.toContain("Kit Bag");
    });

    test("collapses the package half of a mixed token and leaves the rest", async () => {
      // After an attendee merge one code can carry both a private package row
      // and an ordinary one. The package collapses (member concealed) while the
      // ordinary booking still renders — the mixed set must not fall back to a
      // card per row.
      const { group, widget } = await hiddenOneMemberPackage();
      const standalone = await createTestListing({ name: "Standalone Ticket" });
      const token = await bookedToken(
        [
          { listingId: widget.id, packageGroupId: group.id, quantity: 1 },
          { listingId: standalone.id, packageGroupId: group.id, quantity: 1 },
        ],
        "merged",
      );
      // The widget row stays a package member; the standalone row loses its
      // package id, the way a merge leaves the two side by side.
      await getDb().execute({
        args: [standalone.id],
        sql: "UPDATE listing_attendees SET package_group_id = 0 WHERE listing_id = ?",
      });

      const body = await fetchTicketBody(token);
      expect(body).toContain("Kit Bag");
      expect(body).toContain("Standalone Ticket");
      expect(body).not.toContain("Widget");
    });
  });

  test("keeps two buyers of one package on separate cards and codes", async () => {
    // /t/a+b resolves two distinct attendees sharing a private package. Cards
    // bucket by (code, package), so both collapse yet stay two cards with their
    // own check-in codes. Bucketing on a shared first token used to disable
    // collapsing here and leak the member's name.
    const { group, widget } = await hiddenOneMemberPackage();
    const asPackage = [
      { listingId: widget.id, packageGroupId: group.id, quantity: 1 },
    ];
    const tokenA = await bookedToken(asPackage, "a");
    const tokenB = await bookedToken(asPackage, "b");

    const body = await fetchTicketBody(`${tokenA}+${tokenB}`);
    expect(body).toContain("2 Tickets");
    expect(body).toContain(`/t/${tokenA}/svg`);
    expect(body).toContain(`/t/${tokenB}/svg`);
    expect(body).toContain("Kit Bag");
    expect(body).not.toContain("Widget");
  });

  describe("the date a dated package card carries", () => {
    /** A package whose members are booked by the day, each member named and
     * given its own fixed length. */
    const dayPackage = async (
      name: string,
      members: { durationDays?: number; name: string }[],
    ) => {
      const group = await createTestGroup({ isPackage: true, name });
      const made = [];
      for (const member of members) {
        made.push(
          await createTestListing({
            groupId: group.id,
            listingType: "daily",
            minimumDaysBefore: 0,
            name: member.name,
            ...(member.durationDays === undefined
              ? {}
              : { durationDays: member.durationDays }),
          }),
        );
      }
      return { group, made };
    };

    test("shows the widest member's stay, whatever order the rows arrive in", async () => {
      // A daily package books every member on one start date, and its members
      // can carry different fixed lengths — the widest covers the whole stay.
      // Booked narrow → widest → narrow, so the scan must both REPLACE a
      // narrower card and KEEP the widest over a later narrower one.
      const { group, made } = await dayPackage("Trip", [
        { name: "Trip Canoe" },
        { durationDays: 2, name: "Trip Cabin" },
        { name: "Trip Kayak" },
      ]);
      const [oneDay, twoDay, oneDayB] = made;
      const date = addDays(todayInTz("UTC"), 2);

      const body = await ticketBodyForBooking(
        [
          {
            date,
            listingId: oneDay!.id,
            packageGroupId: group.id,
            quantity: 1,
          },
          // The real booking flow stores a fixed daily member's length, so the
          // stored range reflects the two-day stay.
          {
            date,
            durationDays: 2,
            listingId: twoDay!.id,
            packageGroupId: group.id,
            quantity: 1,
          },
          {
            date,
            listingId: oneDayB!.id,
            packageGroupId: group.id,
            quantity: 1,
          },
        ],
        "tripper",
      );
      expect(body).toContain(
        formatDateRangeLabelCompactEn(date, addDays(date, 1)),
      );
    });

    test("shows the stay that was booked, not the longest one on offer", async () => {
      // Regression: the card read the listing's own duration_days (the LONGEST
      // bookable), so a three-day booking of a seven-day-maximum member drew a
      // seven-day stay. Both the widest-member pick and the label must read the
      // stored booked range — the facts the confirmation email renders.
      const group = await createTestGroup({ isPackage: true, name: "Flex" });
      const flex = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 500, 3: 1200, 7: 2500 },
        durationDays: 7,
        groupId: group.id,
        listingType: "daily",
        minimumDaysBefore: 0,
        name: "Flex Lodge",
      });
      const fixed = await createTestListing({
        groupId: group.id,
        listingType: "daily",
        minimumDaysBefore: 0,
        name: "Flex Firepit",
      });
      const date = addDays(todayInTz("UTC"), 2);

      const body = await ticketBodyForBooking(
        [
          {
            date,
            durationDays: 3,
            listingId: flex.id,
            packageGroupId: group.id,
            quantity: 1,
          },
          { date, listingId: fixed.id, packageGroupId: group.id, quantity: 1 },
        ],
        "flexer",
      );
      expect(body).toContain(
        formatDateRangeLabelCompactEn(date, addDays(date, 2)),
      );
      expect(body).not.toContain(
        formatDateRangeLabelCompactEn(date, addDays(date, 6)),
      );
    });
  });

  describe("what a free public package checkout leaves behind", () => {
    /** A private package whose sole member is free, so the public checkout
     * finishes without a payment provider. */
    const freeHiddenPackage = async (
      name: string,
      slug: string,
      member: { name: string; thankYouUrl?: string },
    ) => {
      const group = await createTestGroup({ isPackage: true, name, slug });
      await groups.table.update(group.id, { hidePackageListings: true });
      const freebie = await createTestListing({
        groupId: group.id,
        name: member.name,
        unitPrice: 0,
        ...(member.thankYouUrl === undefined
          ? {}
          : { thankYouUrl: member.thankYouUrl }),
      });
      return { freebie, group };
    };

    /** Drive the public free checkout for a package group, one package. */
    const buyOnePackage = (
      group: { id: number; slug: string },
      who: string,
    ): Promise<Response> =>
      submitPackageBooking(group.slug, {
        email: `${who}@test.com`,
        name: who,
        [`package_quantity_${group.id}`]: "1",
      });

    test("stamps the package id onto the booking row", async () => {
      // The standalone-versus-package distinction is a stored fact, not one the
      // ticket page infers, so the free path must thread the package id all the
      // way through to the write.
      const { freebie, group } = await freeHiddenPackage(
        "Free Kit",
        "free-kit",
        { name: "Freebie" },
      );

      const submit = await buyOnePackage(group, "freepkg");
      expect([302, 303]).toContain(submit.status);

      const row = (
        await getDb().execute({
          args: [freebie.id],
          sql: "SELECT package_group_id FROM listing_attendees WHERE listing_id = ? ORDER BY id DESC LIMIT 1",
        })
      ).rows[0]!;
      expect(Number(row.package_group_id)).toBe(group.id);
    });

    test("ignores the member's own thank-you page", async () => {
      // With one member a package booking would otherwise fall through the
      // single-listing thank-you redirect and send the buyer to that member's
      // page, naming what the private package conceals.
      const { group } = await freeHiddenPackage("Secret Kit", "secret-kit", {
        name: "Concealed Freebie",
        thankYouUrl: "https://example.com/concealed-member",
      });

      const submit = await buyOnePackage(group, "secret");
      expect([302, 303]).toContain(submit.status);
      const location = submit.headers.get("location") ?? "";
      expect(location).not.toContain("concealed-member");
      expect(location).toContain("/ticket/reserved");
    });
  });
});
