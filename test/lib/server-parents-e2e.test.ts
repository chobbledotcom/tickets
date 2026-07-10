import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import type { Listing } from "#shared/types.ts";
import {
  bookingPageHtml,
  bookParent,
  childField,
  createDailyTestListing,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectPackageBookingAccepted,
  expectRejectedBooking,
  expectReserved,
  makeParent,
  parentField,
  postBooking,
  postCalculate,
  submitPackageBooking,
  ticketPageStatus,
} from "#test-utils";
import { firstBookableDate } from "./server-parents-gate/helpers.ts";

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
  const { parent, children } = await makeParent({
    children: [
      {
        daily: true,
        maxAttendees: 10,
        maxQuantity: 3,
        name: "Add-on Alpha",
        unitPrice: 1500,
      },
      {
        daily: true,
        maxAttendees: 10,
        maxQuantity: 3,
        name: "Add-on Beta",
        unitPrice: 2500,
      },
    ],
    parent: {
      daily: true,
      maxAttendees: 10,
      maxQuantity: 3,
      name: "Daily base unit",
      unitPrice: 4000,
    },
  });
  const [childA, childB] = children;

  const date = await firstBookableDate(parent.id);

  return { childA: childA!, childB: childB!, date, parent };
};

/** The persisted order_token + parent_listing_id of every listing_attendees row
 * for one listing, newest first — the attendee-side parent/child metadata. */
const orderRowsFor = async (
  listingId: number,
): Promise<{ order_token: string; parent_listing_id: number }[]> => {
  const { queryAll } = await import("#shared/db/client.ts");
  return queryAll<{ order_token: string; parent_listing_id: number }>(
    `SELECT order_token, parent_listing_id FROM listing_attendees
     WHERE listing_id = ? ORDER BY id DESC`,
    [listingId],
  );
};

/** The persisted listing_attendees rows for one listing (quantity, parent, and
 * package group), newest first — the booking-side facts an e2e journey checks. */
const bookingRowsFor = async (
  listingId: number,
): Promise<
  { quantity: number; parent_listing_id: number; package_group_id: number }[]
> => {
  const { queryAll } = await import("#shared/db/client.ts");
  return queryAll(
    `SELECT quantity, parent_listing_id, package_group_id FROM listing_attendees
     WHERE listing_id = ? ORDER BY id DESC`,
    [listingId],
  );
};

/** "Ada Lovelace" booking; asserts reserved. */
const adaLoveBook = async (
  parent: Listing,
  date: string,
  extra: Record<string, string>,
) => {
  const res = await postBooking(parent.slug, {
    date,
    email: "ada@example.com",
    name: "Ada Lovelace",
    ...extra,
  });
  expectReserved(res);
  return res;
};

/** Asserts one attendee row per child with qty 1; returns rows for extra checks. */
const assertOneEachPersisted = async (childA: Listing, childB: Listing) => {
  const rowsA = await getAttendeesRaw(childA.id);
  const rowsB = await getAttendeesRaw(childB.id);
  expect(rowsA.length).toBe(1);
  expect(rowsA[0]?.quantity).toBe(1);
  expect(rowsB.length).toBe(1);
  expect(rowsB[0]?.quantity).toBe(1);
  return { rowsA, rowsB };
};

/** Book 2 parents with 1 of each child (Ada Lovelace, asserts reserved). */
const bookOneOfEach = (
  parent: Listing,
  childA: Listing,
  childB: Listing,
  date: string,
) =>
  adaLoveBook(parent, date, {
    ...parentField(parent, "2"),
    ...childField(parent, childA, "1"),
    ...childField(parent, childB, "1"),
  });

/** Book 2 parents with 2 of childA only (Ada Lovelace, asserts reserved). */
const bookTwoOfOne = (parent: Listing, childA: Listing, date: string) =>
  adaLoveBook(parent, date, {
    ...parentField(parent, "2"),
    ...childField(parent, childA, "2"),
  });

/** Set up parent+two children, book one of each — shared by ordering/detail tests. */
const setupAndBookOneOfEach = async () => {
  const { parent, childA, childB, date } = await setupParentWithTwoChildren();
  await bookOneOfEach(parent, childA, childB, date);
  return { childA, childB, date, parent };
};

/** Set up parent+two children, book two of childA — shared by two-of-one tests. */
const setupAndBookTwoOfOne = async () => {
  const { parent, childA, childB, date } = await setupParentWithTwoChildren();
  await bookTwoOfOne(parent, childA, date);
  return { childA, childB, date, parent };
};

/** Set up parent+two children and pre-compute the base adaBook fields (2×childA).
 * Returns the entities and baseFields so callers can call adaBook with extra fields. */
const setupTwoChildrenBase = async () => {
  const { parent, childA, childB, date } = await setupParentWithTwoChildren();
  const baseFields = {
    ...parentField(parent, "2"),
    ...childField(parent, childA, "2"),
  };
  return { baseFields, childA, childB, date, parent };
};

/** A standalone free daily listing plus its first bookable date, already booked. */
const setupStandalone = async (): Promise<{
  standalone: Listing;
  date: string;
}> => {
  const standalone = await createDailyTestListing({
    maxAttendees: 10,
    maxQuantity: 3,
    name: "Plain listing",
    thankYouUrl: "",
    unitPrice: 0,
  });
  const date = await firstBookableDate(standalone.id);
  const res = await postBooking(standalone.slug, {
    date,
    email: "ada@example.com",
    name: "Ada Lovelace",
    [`quantity_${standalone.id}`]: "1",
  });
  expectReserved(res);
  return { date, standalone };
};

describeWithEnv(
  "server > parents end-to-end booking journey",
  { db: true, triggers: true },
  () => {
    test("the booking page renders both per-unit child selectors and the choose-N total guidance", async () => {
      const { parent, childA, childB } = await setupParentWithTwoChildren();
      const html = await bookingPageHtml(parent.slug);

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
      const res = await bookParent(parent.slug, {
        date,
        ...parentField(parent, "1"),
      });
      await expectRejectedBooking(
        res,
        parent.id,
        `Choose 1 more add-on for ${parent.name}.`,
      );
    });

    test("parent qty 1 with one child unit is accepted", async () => {
      const { parent, childA, childB, date } =
        await setupParentWithTwoChildren();
      const res = await bookParent(parent.slug, {
        date,
        ...parentField(parent, "1"),
        ...childField(parent, childA, "1"),
      });
      expectReserved(res);
      const rowsA = await getAttendeesRaw(childA.id);
      expect(rowsA.length).toBe(1);
      expect(rowsA[0]?.quantity).toBe(1);
      expect((await getAttendeesRaw(childB.id)).length).toBe(0);
    });

    test("parent qty 2 with two of one child is accepted and folds a single line", async () => {
      const { parent, childA, childB, date, baseFields } =
        await setupTwoChildrenBase();
      const res = await bookParent(parent.slug, { date, ...baseFields });
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
      const res = await bookParent(parent.slug, {
        date,
        ...parentField(parent, "2"),
        ...childField(parent, childA, "1"),
        ...childField(parent, childB, "1"),
      });
      expectReserved(res);
      await assertOneEachPersisted(childA, childB);
    });

    test("parent qty 2 with only one child unit is rejected (too few)", async () => {
      const { parent, childA, date } = await setupParentWithTwoChildren();
      const res = await bookParent(parent.slug, {
        date,
        ...parentField(parent, "2"),
        ...childField(parent, childA, "1"),
      });
      await expectRejectedBooking(
        res,
        parent.id,
        `Choose 1 more add-on for ${parent.name}.`,
      );
    });

    test("parent qty 2 with three child units is rejected (too many)", async () => {
      const { parent, childB, date, baseFields } = await setupTwoChildrenBase();
      const res = await bookParent(parent.slug, {
        date,
        ...baseFields,
        ...childField(parent, childB, "1"),
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
        ...parentField(parent, "2"),
        ...childField(parent, childA, "1"),
        ...childField(parent, childB, "1"),
      });
      expect(fragment).toContain("£120");

      // Each child's distinct price is independently load-bearing: a qty-1 parent
      // (£40) with one child Alpha (£15) totals £55, and with one child Beta (£25)
      // totals £65 — so swapping the two children's prices would change both.
      const alphaOnly = await postCalculate(parent.slug, {
        date,
        ...parentField(parent, "1"),
        ...childField(parent, childA, "1"),
      });
      expect(alphaOnly).toContain("£55");
      const betaOnly = await postCalculate(parent.slug, {
        date,
        ...parentField(parent, "1"),
        ...childField(parent, childB, "1"),
      });
      expect(betaOnly).toContain("£65");
    });

    test("a one-of-each booking persists parent qty 2 and each child qty 1 on the parent's date", async () => {
      const { parent, childA, childB, date } = await setupAndBookOneOfEach();

      const parentRows = await getAttendeesRaw(parent.id);
      expect(parentRows.length).toBe(1);
      expect(parentRows[0]?.quantity).toBe(2);
      expect(parentRows[0]?.date).toBe(date);

      const { rowsA, rowsB } = await assertOneEachPersisted(childA, childB);
      // The daily child inherits the parent's date (invariant I4).
      expect(rowsA[0]?.date).toBe(date);
      expect(rowsB[0]?.date).toBe(date);
    });

    test("a two-of-one booking persists child Alpha qty 2 and no child Beta line", async () => {
      const { childA, childB } = await setupAndBookTwoOfOne();

      const rowsA = await getAttendeesRaw(childA.id);
      expect(rowsA.length).toBe(1);
      expect(rowsA[0]?.quantity).toBe(2);
      expect((await getAttendeesRaw(childB.id)).length).toBe(0);
    });

    test("admin attendee pages show the booking and each chosen child quantity", async () => {
      const { parent, childA, childB, date } = await setupAndBookOneOfEach();

      const { adminGet } = await import("#test-utils");

      // The parent listing's attendee page lists the buyer with quantity 2.
      const parentPage = await adminGet(
        `/admin/listing/${parent.id}/attendees?date=${date}`,
      );
      expect(parentPage.status).toBe(200);
      const parentHtml = await parentPage.text();
      expect(parentHtml).toContain("Ada Lovelace");
      expect(parentHtml).toContain('<td class="col-quantity">2</td>');

      // Child Alpha's page lists the buyer with the chosen quantity 1.
      const childAPage = await adminGet(
        `/admin/listing/${childA.id}/attendees?date=${date}`,
      );
      expect(childAPage.status).toBe(200);
      const childAHtml = await childAPage.text();
      expect(childAHtml).toContain("Ada Lovelace");
      expect(childAHtml).toContain('<td class="col-quantity">1</td>');

      // Child Beta's page lists the buyer with the chosen quantity 1.
      const childBPage = await adminGet(
        `/admin/listing/${childB.id}/attendees?date=${date}`,
      );
      expect(childBPage.status).toBe(200);
      const childBHtml = await childBPage.text();
      expect(childBHtml).toContain("Ada Lovelace");
      expect(childBHtml).toContain('<td class="col-quantity">1</td>');
    });

    test("a one-of-each booking shares one order token and records each child's parent", async () => {
      const { parent, childA, childB } = await setupAndBookOneOfEach();

      const parentRow = (await orderRowsFor(parent.id))[0]!;
      const rowA = (await orderRowsFor(childA.id))[0]!;
      const rowB = (await orderRowsFor(childB.id))[0]!;

      // Every row of the booking carries the same non-empty order token.
      expect(parentRow.order_token).not.toBe("");
      expect(rowA.order_token).toBe(parentRow.order_token);
      expect(rowB.order_token).toBe(parentRow.order_token);

      // The parent's own row is not a folded child; each child records the parent.
      expect(parentRow.parent_listing_id).toBe(0);
      expect(rowA.parent_listing_id).toBe(parent.id);
      expect(rowB.parent_listing_id).toBe(parent.id);
    });

    test("a two-of-one booking records both units of the child under the parent", async () => {
      const { parent, childA } = await setupAndBookTwoOfOne();

      const rowsA = await orderRowsFor(childA.id);
      const parentRows = await orderRowsFor(parent.id);
      // The two units fold into one line (the unique index), recorded under the
      // parent and sharing the parent's order token.
      expect(rowsA.length).toBe(1);
      expect(rowsA[0]!.parent_listing_id).toBe(parent.id);
      expect(rowsA[0]!.order_token).toBe(parentRows[0]!.order_token);
      expect(rowsA[0]!.order_token).not.toBe("");
    });

    test("a standalone booking has an empty order token and no parent", async () => {
      const { standalone } = await setupStandalone();

      const rows = await orderRowsFor(standalone.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.order_token).toBe("");
      expect(rows[0]!.parent_listing_id).toBe(0);
    });

    test("the admin attendee detail page labels each child under its parent", async () => {
      const { parent } = await setupAndBookOneOfEach();

      const { adminGet } = await import("#test-utils");
      const { getAttendeesRaw: rawFor } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendeeId = (await rawFor(parent.id))[0]!.id;
      const page = await adminGet(`/admin/attendees/${attendeeId}`);
      expect(page.status).toBe(200);
      const html = await page.text();

      // Both children are annotated as add-ons chosen under the parent; the
      // parent's own row carries no such annotation.
      expect(html).toContain("Add-on chosen under Daily base unit");
      expect(html).toContain("Add-on Alpha");
      expect(html).toContain("Add-on Beta");
    });

    test("a standalone booking's attendee detail page shows no add-on annotation", async () => {
      const { standalone } = await setupStandalone();

      const { adminGet } = await import("#test-utils");
      const { getAttendeesRaw: rawFor } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendeeId = (await rawFor(standalone.id))[0]!.id;
      const page = await adminGet(`/admin/attendees/${attendeeId}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).not.toContain("Add-on chosen under");
    });

    test("the admin calendar shows the parent and inherited-date child bookings on the parent's date", async () => {
      const { date } = await setupAndBookOneOfEach();

      const { adminGet } = await import("#test-utils");
      const calendar = await adminGet(`/admin/calendar?date=${date}`);
      expect(calendar.status).toBe(200);
      const html = await calendar.text();

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

/** A free "pick a widget" parent whose sole child widget is ALSO sold on its
 * own (`bookableAlone`), wired as a parent edge — the two-path shape the
 * standalone-child purchases exercise. */
const setupPickerWithSoloWidget = async (): Promise<{
  parent: Listing;
  widget: Listing;
}> => {
  const parent = await createTestListing({
    maxAttendees: 10,
    name: "Widget Picker",
    unitPrice: 0,
  });
  const widget = await createTestListing({
    bookableAlone: true,
    maxAttendees: 10,
    maxQuantity: 3,
    name: "Solo Widget",
    thankYouUrl: "",
    unitPrice: 0,
  });
  await listingChildren.setIds(parent.id, [widget.id]);
  return { parent, widget };
};

describeWithEnv(
  "e2e > standalone and package-member child purchases",
  { db: true, triggers: true },
  () => {
    test("buying a can-book-itself child on its own page books it standalone", async () => {
      // A "pick a widget" parent offers a widget that is ALSO sold on its own.
      // The buyer books the widget directly on its own page — it books as a
      // standalone attendee, not folded under the picker.
      const { widget } = await setupPickerWithSoloWidget();
      // Its own page serves — a non-flagged child would 404 here.
      expect(await ticketPageStatus(widget.slug)).toBe(200);

      const res = await postBooking(widget.slug, {
        email: "ada@example.com",
        name: "Ada Lovelace",
        [`quantity_${widget.id}`]: "1",
      });
      expectReserved(res);

      const rows = await bookingRowsFor(widget.id);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.quantity)).toBe(1);
      // Booked on its own, with no parent — not folded under the picker.
      expect(Number(rows[0]!.parent_listing_id)).toBe(0);
    });

    test("buying the child on its own row AND under its parent books one row per path", async () => {
      // One order, two paths for the widget: auto-folded under the picker
      // (sole bookable child fills to the parent quantity) plus its own
      // standalone row. The split must persist one parented row and one
      // parent-less row — never a doubled allocation or a rejected order.
      const { parent, widget } = await setupPickerWithSoloWidget();

      const res = await postBooking(`${parent.slug}+${widget.slug}`, {
        email: "both@example.com",
        name: "Both Paths",
        [`quantity_${parent.id}`]: "1",
        [`quantity_${widget.id}`]: "1",
      });
      expectReserved(res);

      const rows = await bookingRowsFor(widget.id);
      expect(
        rows.map((row) => [
          Number(row.parent_listing_id),
          Number(row.quantity),
        ]),
      ).toEqual(
        expect.arrayContaining([
          [parent.id, 1],
          [0, 1],
        ]),
      );
      expect(rows).toHaveLength(2);
      expect(await bookingRowsFor(parent.id)).toHaveLength(1);
    });

    test("buying a package folds the parent member's chosen child under it", async () => {
      // A package whose member is a "pick a widget" parent. Buying the package
      // and choosing a widget books the widget folded under its member parent,
      // sharing the order's package group.
      const group = await createTestGroup({
        isPackage: true,
        name: "Kit",
        slug: "e2e-kit",
      });
      const picker = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "Kit Picker",
        unitPrice: 0,
      });
      const base = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "Kit Base",
        unitPrice: 0,
      });
      const widget = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 10,
        name: "Kit Widget",
        unitPrice: 0,
      });
      await listingChildren.setIds(picker.id, [widget.id]);
      const { setGroupPackageMembers } = await import("#shared/db/groups.ts");
      await setGroupPackageMembers(group.id, [
        { listingId: picker.id, price: 0 },
        { listingId: base.id, price: 0 },
      ]);

      const submit = await submitPackageBooking(group.slug, {
        [`child_qty_${picker.id}_${widget.id}`]: "1",
        email: "kit@example.com",
        name: "Kit Buyer",
        [`package_quantity_${group.id}`]: "1",
      });
      await expectPackageBookingAccepted(submit);

      // The widget booked under its parent member, tagged with the package group.
      const widgetRows = await bookingRowsFor(widget.id);
      expect(widgetRows).toHaveLength(1);
      expect(Number(widgetRows[0]!.parent_listing_id)).toBe(picker.id);
      expect(Number(widgetRows[0]!.package_group_id)).toBe(group.id);
      // Both package members booked too.
      expect(await bookingRowsFor(picker.id)).toHaveLength(1);
      expect(await bookingRowsFor(base.id)).toHaveLength(1);
    });

    test("a bookable_alone child's standalone row reserves its parent's folded demand", async () => {
      // Parent (max 2) and its can-book-itself child (capacity 3) both render on
      // /ticket/<parent>+<child>. The child's own row must hold back the 2 units
      // the parent could fold, offering only 1 — so the standalone row plus the
      // parent selector can never demand more than the child's 3 spots (the old
      // row offered the full 3, letting the page over-offer past capacity).
      const parent = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 2,
        name: "Base",
      });
      const widget = await createTestListing({
        bookableAlone: true,
        maxAttendees: 3,
        maxQuantity: 5,
        name: "Solo Widget",
      });
      await listingChildren.setIds(parent.id, [widget.id]);

      const html = await bookingPageHtml(`${parent.slug}+${widget.slug}`);
      const select = html.slice(
        html.indexOf(`name="quantity_${widget.id}"`),
        html.indexOf("</select>", html.indexOf(`name="quantity_${widget.id}"`)),
      );
      const offered = [...select.matchAll(/value="(\d+)"/g)].map((m) =>
        Number(m[1]),
      );
      expect(Math.max(...offered)).toBe(1);
    });
  },
);
