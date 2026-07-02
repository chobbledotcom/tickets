import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { addDays } from "#shared/dates.ts";
import { queryAll } from "#shared/db/client.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectPackageBookingAccepted,
  mockRequest,
  submitPackageBooking,
} from "#test-utils";

/** A start date comfortably inside every member's booking window. */
const bookingDate = (): string => addDays(todayInTz("UTC"), 2);

/** The booking rows for a listing, newest first. */
const bookingRows = (
  listingId: number,
): Promise<
  { start_at: string | null; quantity: number; package_group_id: number }[]
> =>
  queryAll(
    `SELECT start_at, quantity, package_group_id FROM listing_attendees
      WHERE listing_id = ? ORDER BY id DESC`,
    [listingId],
  );

/** A free daily package with two members sharing the default booking window. */
const dailyPackage = async (name: string, slug: string) => {
  const group = await createTestGroup({ isPackage: true, name, slug });
  const tent = await createTestListing({
    groupId: group.id,
    listingType: "daily",
    maxAttendees: 10,
    minimumDaysBefore: 0,
    name: `${name} Tent`,
    unitPrice: 0,
  });
  const firepit = await createTestListing({
    groupId: group.id,
    listingType: "daily",
    maxAttendees: 10,
    minimumDaysBefore: 0,
    name: `${name} Firepit`,
    unitPrice: 0,
  });
  return { firepit, group, tent };
};

describeWithEnv("daily packages (/ticket/<group-slug>)", { db: true }, () => {
  test("the package page renders one shared date selector", async () => {
    const { group } = await dailyPackage("Camp", "camp-pkg");
    const body = await (
      await handleRequest(mockRequest(`/ticket/${group.slug}`))
    ).text();
    // One date control for the whole bundle (members share the start date).
    expect(body).toContain('name="date"');
    // The package quantity selector still rides alongside it.
    expect(body).toContain('name="package_quantity"');
  });

  test("books every member on the chosen date, stamped with the group", async () => {
    const { firepit, group, tent } = await dailyPackage("Trip", "trip-pkg");
    const date = bookingDate();

    const submit = await submitPackageBooking(group.slug, {
      date,
      email: "camper@test.com",
      name: "Camper",
      package_quantity: "1",
    });
    await expectPackageBookingAccepted(submit);

    for (const member of [tent, firepit]) {
      const rows = await bookingRows(member.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.start_at?.slice(0, 10)).toBe(date);
      expect(Number(rows[0]!.package_group_id)).toBe(group.id);
      expect(rows[0]!.quantity).toBe(1);
    }
  });

  test("rejects a package booking without a date", async () => {
    const { firepit, group, tent } = await dailyPackage("NoDate", "nodate-pkg");
    const submit = await submitPackageBooking(group.slug, {
      email: "nodate@test.com",
      name: "No Date",
      package_quantity: "1",
    });
    // The submit bounces back with the date error; nothing is booked.
    expect([302, 303]).toContain(submit.status);
    expect(await bookingRows(tent.id)).toHaveLength(0);
    expect(await bookingRows(firepit.id)).toHaveLength(0);
  });

  test("a full member makes the bundle unavailable, matching the standalone daily gate", async () => {
    // Page-level daily capacity is date-blind app-wide: a standalone daily
    // listing whose bookings reach max_attendees shows "this listing is full"
    // regardless of date (the per-date atomic write gate underneath is strictly
    // looser, so it can never over-admit). The package gate mirrors that: a
    // member at its cap makes the whole bundle unbookable.
    const { group, tent } = await dailyPackage("Tight", "tight-pkg");
    const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
    const { listingsTable } = await import("#shared/db/listings.ts");
    const dateA = bookingDate();
    await listingsTable.update(tent.id, { maxAttendees: 1 });
    const fill = await createAttendeeAtomic({
      bookings: [{ date: dateA, listingId: tent.id, quantity: 1 }],
      email: "first@test.com",
      name: "First",
    });
    if (!fill.success) throw new Error("fill booking failed");

    // The bundle can no longer fit, so the package page itself is gone…
    const page = await handleRequest(mockRequest(`/ticket/${group.slug}`));
    await page.body?.cancel();
    expect(page.status).toBe(404);

    // …and no crafted POST can book past the full member.
    const { mockTicketFormRequest } = await import("#test-utils/mocks.ts");
    const blocked = await handleRequest(
      mockTicketFormRequest(
        group.slug,
        {
          date: addDays(dateA, 1),
          email: "late@test.com",
          name: "Late",
          package_quantity: "1",
        },
        // No live page means no CSRF token to seed; the gate 404s first anyway.
        "",
      ),
    );
    expect(blocked.status).toBe(404);
    expect(await bookingRows(tent.id)).toHaveLength(1);
  });

  test("a customisable package offers the members' shared day counts with summed prices", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Flex Kit",
      slug: "flex-kit",
    });
    await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000, 2: 1800 },
      durationDays: 2,
      groupId: group.id,
      listingType: "daily",
      minimumDaysBefore: 0,
      name: "Flex Boat",
      unitPrice: 1000,
    });
    await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 500, 2: 900, 3: 1200 },
      durationDays: 3,
      groupId: group.id,
      listingType: "daily",
      minimumDaysBefore: 0,
      name: "Flex Hut",
      unitPrice: 500,
    });
    const body = await (
      await handleRequest(mockRequest(`/ticket/${group.slug}`))
    ).text();
    // The bundle offers only the day counts EVERY member supports: 1 and 2,
    // never the hut-only 3-day option.
    expect(body).toContain('name="day_count"');
    expect(body).toContain('value="1"');
    expect(body).toContain('value="2"');
    expect(body).not.toContain('value="3"');
    // Each option is labelled with the whole bundle's total for that span —
    // the members' ENTERED day prices summed (1000+500, 1800+900), never
    // base × days.
    expect(body).toContain("£15");
    expect(body).toContain("£27");
  });

  test("a customisable package prices each member's own day price, never base times days", async () => {
    const { postCalculate } = await import("#test-utils/parents.ts");
    const group = await createTestGroup({
      isPackage: true,
      name: "Priced Flex",
      slug: "priced-flex",
    });
    await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000, 2: 1800 },
      durationDays: 2,
      groupId: group.id,
      listingType: "daily",
      minimumDaysBefore: 0,
      name: "Priced Boat",
      unitPrice: 1000,
    });
    await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 500, 2: 900 },
      durationDays: 2,
      groupId: group.id,
      listingType: "daily",
      minimumDaysBefore: 0,
      name: "Priced Hut",
      unitPrice: 500,
    });
    const fragment = await postCalculate(group.slug, {
      date: bookingDate(),
      day_count: "2",
      package_quantity: "1",
    });
    // 2-day bundle = boat 1800 + hut 900 = £27 — each member's ENTERED 2-day
    // price, not base × 2 (which would be £30).
    expect(fragment).toContain("£27");
    expect(fragment).not.toContain("£30");
  });

  /** The shared two-member customisable package (boat 1000/1800, hut 500/900)
   * with the boat's per-day PACKAGE overrides applied, for pricing tests. */
  const overriddenFlexPackage = async (
    name: string,
    slug: string,
    boatOverrides: { price: number | null; dayPrices?: Record<number, number> },
  ) => {
    const { createFlexPackage } = await import("#test-utils/packages.ts");
    return createFlexPackage(name, slug, boatOverrides);
  };

  test("a per-day package override reprices that span, beating the member's own day price", async () => {
    const { postCalculate } = await import("#test-utils/parents.ts");
    const { group } = await overriddenFlexPackage(
      "Override Flex",
      "override-flex",
      { dayPrices: { 2: 1500 }, price: null },
    );
    const fragment = await postCalculate(group.slug, {
      date: bookingDate(),
      day_count: "2",
      package_quantity: "1",
    });
    // Boat's 2-day price is overridden to 1500 inside this package; the hut
    // keeps its own 900. Total £24, never the un-overridden £27.
    expect(fragment).toContain("£24");
    expect(fragment).not.toContain("£27");
  });

  test("an explicit 0 per-day override makes that span free in the package", async () => {
    const { postCalculate } = await import("#test-utils/parents.ts");
    const { group } = await overriddenFlexPackage("Free Span", "free-span", {
      dayPrices: { 2: 0 },
      price: null,
    });
    const fragment = await postCalculate(group.slug, {
      date: bookingDate(),
      day_count: "2",
      package_quantity: "1",
    });
    // The boat's 2-day span is explicitly FREE inside this package (0 is a real
    // override, not "no override"); only the hut's own 900 charges.
    expect(fragment).toContain("£9");
    expect(fragment).not.toContain("£27");
  });

  test("a flat package override still wins over a per-day override", async () => {
    const { postCalculate } = await import("#test-utils/parents.ts");
    const { group } = await overriddenFlexPackage("Flat Flex", "flat-flex", {
      dayPrices: { 2: 1500 },
      price: 500,
    });
    const fragment = await postCalculate(group.slug, {
      date: bookingDate(),
      day_count: "2",
      package_quantity: "1",
    });
    // The boat's flat 500 override is one price whatever the span, outranking
    // both its 2-day override (1500) and its own day price (1800): 500 + 900.
    expect(fragment).toContain("£14");
  });
});
