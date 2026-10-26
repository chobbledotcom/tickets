/**
 * End-to-end journeys for a parent whose child can also be bought on its own:
 * standalone-child purchases and package-member children.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingChildren } from "#db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  expectPackageBookingAccepted,
  submitPackageBooking,
} from "#test-utils/packages.ts";
import {
  bookingPageHtml,
  expectReserved,
  postBooking,
  ticketPageStatus,
} from "#test-utils/parents.ts";
import type { Listing } from "#types";

/** The persisted listing_attendees rows for one listing (quantity, parent, and
 * package group), newest first — the booking-side facts an e2e journey checks. */
const bookingRowsFor = async (
  listingId: number,
): Promise<
  { quantity: number; parent_listing_id: number; package_group_id: number }[]
> => {
  const { queryAll } = await import("#db/client.ts");
  return queryAll(
    `SELECT quantity, parent_listing_id, package_group_id FROM listing_attendees
     WHERE listing_id = ? ORDER BY id DESC`,
    [listingId],
  );
};

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
      const { setGroupPackageMembers } = await import("#db/groups.ts");
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
