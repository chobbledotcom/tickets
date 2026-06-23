import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { setChildIds } from "#shared/db/listing-parents.ts";
import type { Listing } from "#shared/types.ts";
import {
  createDailyTestListing,
  describeWithEnv,
  expectFlash,
  getTicketCsrfToken,
} from "#test-utils";

/**
 * End-to-end journey for the parent/child (per-unit) booking flow: a daily
 * parent with two daily children of distinct prices, exercised from the public
 * booking page through persistence to the admin attendee + calendar views.
 *
 * Children inherit the parent's date (both children are daily here), so a real
 * submit on the parent's bookable date creates parent + child attendee rows on
 * that same date, which the calendar then surfaces.
 */

/** A daily parent + two distinct-priced daily children, wired as a parent edge,
 * plus the single bookable date they all share. Returns the ids/slugs/names and
 * the resolved date so each test asserts against concrete values. */
const setupParentWithTwoChildren = async (): Promise<{
  parent: Listing;
  childA: Listing;
  childB: Listing;
  date: string;
}> => {
  const parent = await createDailyTestListing({
    maxAttendees: 10,
    maxQuantity: 3,
    name: "Daily base unit",
    thankYouUrl: "",
    unitPrice: 4000,
  });
  const childA = await createDailyTestListing({
    maxAttendees: 10,
    maxQuantity: 3,
    name: "Add-on Alpha",
    thankYouUrl: "",
    unitPrice: 1500,
  });
  const childB = await createDailyTestListing({
    maxAttendees: 10,
    maxQuantity: 3,
    name: "Add-on Beta",
    thankYouUrl: "",
    unitPrice: 2500,
  });
  await setChildIds(parent.id, [childA.id, childB.id]);

  const { getBookableStartDates } = await import("#shared/dates.ts");
  const { getActiveHolidays } = await import("#shared/db/holidays.ts");
  const { getListingWithCount } = await import("#shared/db/listings.ts");
  const parentRow = (await getListingWithCount(parent.id))!;
  const date = getBookableStartDates(parentRow, await getActiveHolidays())[0]!;

  return { childA, childB, date, parent };
};

/** GET the public `/ticket/<slug>` booking page HTML. */
const ticketPageHtml = async (slug: string): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  return (await handleRequest(mockRequest(`/ticket/${slug}`))).text();
};

/** A CSRF token from the rendered booking page (fresh fallback if no form). */
const ticketPageToken = async (slug: string): Promise<string> => {
  const { signCsrfToken } = await import("#shared/csrf.ts");
  return (
    getTicketCsrfToken(await ticketPageHtml(slug)) ?? (await signCsrfToken())
  );
};

/** POST a booking to `/ticket/<slug>` with CSRF auto-added. */
const postBooking = async (
  slug: string,
  fields: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const csrf = await ticketPageToken(slug);
  return handleRequest(
    mockFormRequest(
      `/ticket/${slug}`,
      { csrf_token: csrf, ...fields },
      `csrf_token=${csrf}`,
    ),
  );
};

/** POST a `/calculate` quote, returning the rendered order-summary fragment. */
const postCalculate = async (
  slug: string,
  fields: Record<string, string>,
): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const csrf = await ticketPageToken(slug);
  const res = await handleRequest(
    mockFormRequest(
      `/calculate/${slug}`,
      { csrf_token: csrf, ...fields },
      `csrf_token=${csrf}`,
    ),
  );
  return res.text();
};

/** Assert the response is the public reservation success redirect. */
const expectReserved = (response: Response): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location") ?? "").toMatch(
    /^\/ticket\/reserved\?tokens=.+$/,
  );
};

describeWithEnv(
  "server > parents end-to-end booking journey",
  { db: true, triggers: true },
  () => {
    test("the booking page renders both per-unit child selectors and the choose-N total guidance", async () => {
      const { parent, childA, childB } = await setupParentWithTwoChildren();
      const html = await ticketPageHtml(parent.slug);

      // Per-unit selectors are namespaced per parent+child (invariant I1/I2).
      expect(html).toContain(`name="child_qty_${parent.id}_${childA.id}"`);
      expect(html).toContain(`name="child_qty_${parent.id}_${childB.id}"`);
      // The parent (maxQuantity 3) drives the per-parent total ceiling, so the
      // "choose N in total" note seeds with 3 add-ons; both children's names show.
      expect(html).toContain("3 add-ons in total");
      expect(html).toContain("Choose an option for Daily base unit");
      expect(html).toContain("Add-on Alpha");
      expect(html).toContain("Add-on Beta");
    });

    test("parent qty 1 with no child chosen is rejected (choose 1 more)", async () => {
      const { parent, date } = await setupParentWithTwoChildren();
      const res = await postBooking(parent.slug, {
        date,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(res, "Choose 1 more add-on for Daily base unit.", false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("parent qty 1 with one child unit is accepted", async () => {
      const { parent, childA, childB, date } =
        await setupParentWithTwoChildren();
      const res = await postBooking(parent.slug, {
        date,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
      });
      expectReserved(res);
      const rowsA = await getAttendeesRaw(childA.id);
      expect(rowsA.length).toBe(1);
      expect(rowsA[0]?.quantity).toBe(1);
      expect((await getAttendeesRaw(childB.id)).length).toBe(0);
    });

    test("parent qty 2 with two of one child is accepted and folds a single line", async () => {
      const { parent, childA, childB, date } =
        await setupParentWithTwoChildren();
      const res = await postBooking(parent.slug, {
        date,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "2",
      });
      expectReserved(res);
      const rowsA = await getAttendeesRaw(childA.id);
      expect(rowsA.length).toBe(1);
      expect(rowsA[0]?.quantity).toBe(2);
      // The unchosen sibling gets no line at all.
      expect((await getAttendeesRaw(childB.id)).length).toBe(0);
    });

    test("parent qty 2 with one of each child is accepted and folds two lines", async () => {
      const { parent, childA, childB, date } =
        await setupParentWithTwoChildren();
      const res = await postBooking(parent.slug, {
        date,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
        [`child_qty_${parent.id}_${childB.id}`]: "1",
      });
      expectReserved(res);
      const rowsA = await getAttendeesRaw(childA.id);
      const rowsB = await getAttendeesRaw(childB.id);
      expect(rowsA.length).toBe(1);
      expect(rowsA[0]?.quantity).toBe(1);
      expect(rowsB.length).toBe(1);
      expect(rowsB[0]?.quantity).toBe(1);
    });

    test("parent qty 2 with only one child unit is rejected (too few)", async () => {
      const { parent, childA, date } = await setupParentWithTwoChildren();
      const res = await postBooking(parent.slug, {
        date,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(res, "Choose 1 more add-on for Daily base unit.", false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("parent qty 2 with three child units is rejected (too many)", async () => {
      const { parent, childA, childB, date } =
        await setupParentWithTwoChildren();
      const res = await postBooking(parent.slug, {
        date,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "2",
        [`child_qty_${parent.id}_${childB.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(
        res,
        "Too many add-ons chosen for Daily base unit — remove 1 add-on.",
        false,
      );
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("the quote prices the parent plus the two distinct-priced children", async () => {
      const { parent, childA, childB, date } =
        await setupParentWithTwoChildren();
      // Parent £40 × 2 + child Alpha £15 + child Beta £25 = £120, exercising both
      // children's distinct prices in a single one-of-each order.
      const fragment = await postCalculate(parent.slug, {
        date,
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
        [`child_qty_${parent.id}_${childB.id}`]: "1",
      });
      expect(fragment).toContain("£120");

      // Each child's distinct price is independently load-bearing: a qty-1 parent
      // (£40) with one child Alpha (£15) totals £55, and with one child Beta (£25)
      // totals £65 — so swapping the two children's prices would change both.
      const alphaOnly = await postCalculate(parent.slug, {
        date,
        [`quantity_${parent.id}`]: "1",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
      });
      expect(alphaOnly).toContain("£55");
      const betaOnly = await postCalculate(parent.slug, {
        date,
        [`quantity_${parent.id}`]: "1",
        [`child_qty_${parent.id}_${childB.id}`]: "1",
      });
      expect(betaOnly).toContain("£65");
    });

    test("a one-of-each booking persists parent qty 2 and each child qty 1 on the parent's date", async () => {
      const { parent, childA, childB, date } =
        await setupParentWithTwoChildren();
      const res = await postBooking(parent.slug, {
        date,
        email: "ada@example.com",
        name: "Ada Lovelace",
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
        [`child_qty_${parent.id}_${childB.id}`]: "1",
      });
      expectReserved(res);

      const parentRows = await getAttendeesRaw(parent.id);
      expect(parentRows.length).toBe(1);
      expect(parentRows[0]?.quantity).toBe(2);
      expect(parentRows[0]?.date).toBe(date);

      const rowsA = await getAttendeesRaw(childA.id);
      const rowsB = await getAttendeesRaw(childB.id);
      expect(rowsA.length).toBe(1);
      expect(rowsA[0]?.quantity).toBe(1);
      // The daily child inherits the parent's date (invariant I4).
      expect(rowsA[0]?.date).toBe(date);
      expect(rowsB.length).toBe(1);
      expect(rowsB[0]?.quantity).toBe(1);
      expect(rowsB[0]?.date).toBe(date);
    });

    test("a two-of-one booking persists child Alpha qty 2 and no child Beta line", async () => {
      const { parent, childA, childB, date } =
        await setupParentWithTwoChildren();
      const res = await postBooking(parent.slug, {
        date,
        email: "ada@example.com",
        name: "Ada Lovelace",
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "2",
      });
      expectReserved(res);

      const rowsA = await getAttendeesRaw(childA.id);
      expect(rowsA.length).toBe(1);
      expect(rowsA[0]?.quantity).toBe(2);
      expect((await getAttendeesRaw(childB.id)).length).toBe(0);
    });

    test("admin attendee pages show the booking and each chosen child quantity", async () => {
      const { parent, childA, childB, date } =
        await setupParentWithTwoChildren();
      const res = await postBooking(parent.slug, {
        date,
        email: "ada@example.com",
        name: "Ada Lovelace",
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
        [`child_qty_${parent.id}_${childB.id}`]: "1",
      });
      expectReserved(res);

      const { adminGet } = await import("#test-utils");

      // The parent listing's attendee page lists the buyer with quantity 2.
      const parentPage = await adminGet(
        `/admin/listing/${parent.id}?date=${date}`,
      );
      expect(parentPage.response.status).toBe(200);
      const parentHtml = await parentPage.response.text();
      expect(parentHtml).toContain("Ada Lovelace");
      expect(parentHtml).toContain("<td>2</td>");

      // Child Alpha's page lists the buyer with the chosen quantity 1.
      const childAPage = await adminGet(
        `/admin/listing/${childA.id}?date=${date}`,
      );
      expect(childAPage.response.status).toBe(200);
      const childAHtml = await childAPage.response.text();
      expect(childAHtml).toContain("Ada Lovelace");
      expect(childAHtml).toContain("<td>1</td>");

      // Child Beta's page lists the buyer with the chosen quantity 1.
      const childBPage = await adminGet(
        `/admin/listing/${childB.id}?date=${date}`,
      );
      expect(childBPage.response.status).toBe(200);
      const childBHtml = await childBPage.response.text();
      expect(childBHtml).toContain("Ada Lovelace");
      expect(childBHtml).toContain("<td>1</td>");
    });

    test("the admin calendar shows the parent and inherited-date child bookings on the parent's date", async () => {
      const { parent, childA, childB, date } =
        await setupParentWithTwoChildren();
      const res = await postBooking(parent.slug, {
        date,
        email: "ada@example.com",
        name: "Ada Lovelace",
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
        [`child_qty_${parent.id}_${childB.id}`]: "1",
      });
      expectReserved(res);

      const { adminGet } = await import("#test-utils");
      const calendar = await adminGet(`/admin/calendar?date=${date}`);
      expect(calendar.response.status).toBe(200);
      const html = await calendar.response.text();

      // The buyer appears, and all three listings (parent + both children) are
      // listed against the parent's booked date because the daily children
      // inherit it (invariant I4); the calendar shows the listing column.
      expect(html).toContain("Ada Lovelace");
      expect(html).toContain("Daily base unit");
      expect(html).toContain("Add-on Alpha");
      expect(html).toContain("Add-on Beta");
    });
  },
);
