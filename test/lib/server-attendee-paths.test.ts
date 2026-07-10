import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { revenueAccount } from "#shared/accounting/accounts.ts";
import { accountBalance } from "#shared/accounting/queries.ts";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import { loadExistingLines } from "#shared/db/attendees/atomic-update.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { queryAll } from "#shared/db/client.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import type { Group, Listing } from "#shared/types.ts";
import { attendeeLineIndex } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  type AttendeeLineInput,
  attendeeLineFields,
  buildAttendeeEditForm,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

/**
 * The row-per-path attendee editor: every stored booking row renders as its
 * own editable line (labelled with its path), each line saves independently,
 * and blank per-(package, member) lines let an operator book any path
 * combination a public buyer could — all without JavaScript.
 */

/** A package (member sells for 1000 inside it) beside its member listing. */
const packageAndMember = async (
  name: string,
): Promise<{ group: Group; listing: Listing }> => {
  const group = await createTestGroup({ isPackage: true, name });
  const listing = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 5,
    name: `${name} Tent`,
    unitPrice: 1000,
  });
  await setGroupPackageMembers(group.id, [
    { listingId: listing.id, price: 1000 },
  ]);
  return { group, listing };
};

/** An attendee booking the listing through the package AND its own row. */
const dualPathAttendee = async (
  group: Group,
  listing: Listing,
  email: string,
): Promise<number> => {
  const made = await createAttendeeAtomic({
    bookings: [
      { listingId: listing.id, packageGroupId: group.id, quantity: 2 },
      { listingId: listing.id, quantity: 1 },
    ],
    email,
    name: "Dual Path",
  });
  expect(made.success).toBe(true);
  return (made as Extract<typeof made, { success: true }>).attendees[0]!.id;
};

/** The attendee's stored [package_group_id, quantity] pairs for a listing. */
const pathRows = (
  attendeeId: number,
  listingId: number,
): Promise<{ package_group_id: number; quantity: number }[]> =>
  queryAll(
    `SELECT package_group_id, quantity FROM listing_attendees
      WHERE attendee_id = ? AND listing_id = ?
      ORDER BY package_group_id ASC`,
    [attendeeId, listingId],
  );

/** Assert the attendee's stored [package path, quantity] pairs. */
const expectPaths = async (
  attendeeId: number,
  listingId: number,
  expected: [number, number][],
): Promise<void> => {
  expect(
    (await pathRows(attendeeId, listingId)).map((row) => [
      Number(row.package_group_id),
      row.quantity,
    ]),
  ).toEqual(expected);
};

/** The stored line key of the attendee's row on the given package path. */
const storedKey = async (
  attendeeId: number,
  packageGroupId: number,
): Promise<string> => {
  const rows = await loadExistingLines(attendeeId);
  return rows.find((row) => row.booking.package_group_id === packageGroupId)!
    .key;
};

/** Post the edit form with the given lines and expect it to save. */
const editLines = async (
  attendeeId: number,
  name: string,
  lines: AttendeeLineInput[],
): Promise<void> => {
  const form = await buildAttendeeEditForm(attendeeId, { lines, name });
  const { response } = await adminFormPost(
    `/admin/attendees/${attendeeId}`,
    form,
  );
  expect(response.status).toBe(302);
};

/** Create an attendee through the admin form and return their id. */
const createViaForm = async (
  name: string,
  listingId: number,
  lines: AttendeeLineInput[],
): Promise<number> => {
  const { response } = await adminFormPost("/admin/attendees/new", {
    name,
    ...attendeeLineFields(lines),
  });
  expect(response.status).toBe(302);
  return (await getAttendeesRaw(listingId))[0]!.id;
};

/** Create an attendee through the form booking the listing on BOTH paths —
 * 2 through the package beside 1 standalone — and assert the stored rows. */
const createDualPathViaForm = async (
  name: string,
  group: Group,
  listing: Listing,
): Promise<number> => {
  const attendeeId = await createViaForm(name, listing.id, [
    { eventId: listing.id, packageGroupId: group.id, quantity: 2 },
    { eventId: listing.id, quantity: 1 },
  ]);
  await expectPaths(attendeeId, listing.id, [
    [0, 1],
    [group.id, 2],
  ]);
  return attendeeId;
};

describeWithEnv(
  "admin attendee editor — one line per path",
  { db: true },
  () => {
    test("the edit page renders each path as its own labelled line", async () => {
      const { group, listing } = await packageAndMember("Render Kit");
      // A second member whose package path stays unbooked, so the blank
      // package-path line (and the pure-CSS toggle that reveals it) render.
      const spare = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Render Kit Stove",
        unitPrice: 500,
      });
      await setGroupPackageMembers(group.id, [
        { listingId: listing.id, price: 1000 },
        { listingId: spare.id, price: 500 },
      ]);
      const attendeeId = await dualPathAttendee(
        group,
        listing,
        "render@example.com",
      );

      const html = await (
        await adminGet(`/admin/attendees/${attendeeId}/edit`)
      ).text();
      // Two lines for the one listing: the standalone row and the package row,
      // the latter labelled with the package's name.
      const standaloneIndex = attendeeLineIndex(html, listing.id, 0);
      const packageIndex = attendeeLineIndex(html, listing.id, group.id);
      expect(standaloneIndex).not.toBeNull();
      expect(packageIndex).not.toBeNull();
      expect(standaloneIndex).not.toBe(packageIndex);
      expect(html).toContain("via Render Kit");
      // The blank package-path lines sit behind their pure-CSS toggle.
      expect(html).toContain('name="show_package_paths"');
      expect(html).toContain("attendee-line-package-blank");
    });

    test("each path's quantity saves independently", async () => {
      const { group, listing } = await packageAndMember("Edit Kit");
      const attendeeId = await dualPathAttendee(
        group,
        listing,
        "edit@example.com",
      );

      await editLines(attendeeId, "Dual Path", [
        {
          eventId: listing.id,
          key: await storedKey(attendeeId, 0),
          quantity: 4,
        },
        {
          eventId: listing.id,
          key: await storedKey(attendeeId, group.id),
          quantity: 2,
        },
      ]);
      await expectPaths(attendeeId, listing.id, [
        [0, 4],
        [group.id, 2],
      ]);
    });

    test("zeroing one path's line removes only that row", async () => {
      const { group, listing } = await packageAndMember("Trim Kit");
      const attendeeId = await dualPathAttendee(
        group,
        listing,
        "trim@example.com",
      );

      await editLines(attendeeId, "Dual Path", [
        {
          eventId: listing.id,
          key: await storedKey(attendeeId, 0),
          quantity: 0,
        },
        {
          eventId: listing.id,
          key: await storedKey(attendeeId, group.id),
          quantity: 2,
        },
      ]);
      await expectPaths(attendeeId, listing.id, [[group.id, 2]]);
    });

    test("a blank package line books a NEW row on that path", async () => {
      const { group, listing } = await packageAndMember("Grow Kit");
      // Booked standalone only; the edit adds the package path beside it.
      const made = await createAttendeeAtomic({
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "grow@example.com",
        name: "Grower",
      });
      const attendeeId = (made as Extract<typeof made, { success: true }>)
        .attendees[0]!.id;

      await editLines(attendeeId, "Grower", [
        {
          eventId: listing.id,
          key: await storedKey(attendeeId, 0),
          quantity: 1,
        },
        { eventId: listing.id, packageGroupId: group.id, quantity: 3 },
      ]);
      await expectPaths(attendeeId, listing.id, [
        [0, 1],
        [group.id, 3],
      ]);
    });

    test("creating an attendee can book a package path directly", async () => {
      const { group, listing } = await packageAndMember("Create Kit");
      await createDualPathViaForm("Path Creator", group, listing);
    });

    test("a row tagged with a deleted package is labelled by its id", async () => {
      const { group, listing } = await packageAndMember("Gone Kit");
      const attendeeId = await dualPathAttendee(
        group,
        listing,
        "gone@example.com",
      );
      // Deleting the group leaves the booked row tagged with its id — the
      // label falls back to the id rather than hiding the path.
      const { deleteGroup } = await import("#routes/admin/groups.ts");
      await deleteGroup(group.id);

      const html = await (
        await adminGet(`/admin/attendees/${attendeeId}/edit`)
      ).text();
      expect(html).toContain(`via deleted package #${group.id}`);
    });

    test("a folded add-on row is labelled under its parent", async () => {
      const parent = await createTestListing({
        maxAttendees: 10,
        name: "Addon Parent",
      });
      const child = await createTestListing({
        maxAttendees: 10,
        name: "Addon Child",
      });
      const made = await createAttendeeAtomic({
        bookings: [
          { listingId: parent.id, quantity: 1 },
          { listingId: child.id, parentListingId: parent.id, quantity: 1 },
        ],
        email: "addon@example.com",
        name: "Addon Booker",
      });
      expect(made.success).toBe(true);
      const attendeeId = (made as Extract<typeof made, { success: true }>)
        .attendees[0]!.id;

      const html = await (
        await adminGet(`/admin/attendees/${attendeeId}/edit`)
      ).text();
      expect(html).toContain("add-on under Addon Parent");
    });

    test("an add-on row under a deleted parent is labelled by the parent's id", async () => {
      const parent = await createTestListing({
        maxAttendees: 10,
        name: "Doomed Parent",
      });
      const child = await createTestListing({
        maxAttendees: 10,
        name: "Orphan Child",
      });
      const made = await createAttendeeAtomic({
        bookings: [
          { listingId: child.id, parentListingId: parent.id, quantity: 1 },
        ],
        email: "orphan@example.com",
        name: "Orphan Booker",
      });
      expect(made.success).toBe(true);
      const attendeeId = (made as Extract<typeof made, { success: true }>)
        .attendees[0]!.id;
      // Deleting the parent removes only ITS rows; the child row keeps the
      // stale parent id, so the label falls back to the id.
      const { deleteListing } = await import("#shared/db/listings.ts");
      await deleteListing(parent.id);

      const html = await (
        await adminGet(`/admin/attendees/${attendeeId}/edit`)
      ).text();
      expect(html).toContain(`add-on under ${parent.id}`);
    });

    test("an inactive unbooked package member offers no blank path line", async () => {
      const { group, listing } = await packageAndMember("Idle Kit");
      const spare = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Idle Kit Spare",
        unitPrice: 500,
      });
      await setGroupPackageMembers(group.id, [
        { listingId: listing.id, price: 1000 },
        { listingId: spare.id, price: 500 },
      ]);
      await deactivateTestListing(spare.id);
      const made = await createAttendeeAtomic({
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "idle@example.com",
        name: "Idle Booker",
      });
      const attendeeId = (made as Extract<typeof made, { success: true }>)
        .attendees[0]!.id;

      // The dead member's path renders no blank line; the live member's does.
      const html = await (
        await adminGet(`/admin/attendees/${attendeeId}/edit`)
      ).text();
      expect(attendeeLineIndex(html, spare.id, group.id)).toBeNull();
      expect(attendeeLineIndex(html, listing.id, group.id)).not.toBeNull();
    });

    test("an admin-created package row posts the package's price to the ledger", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Price Kit",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 5,
        name: "Price Kit Tent",
        unitPrice: 1000,
      });
      await setGroupPackageMembers(group.id, [
        { listingId: listing.id, price: 400 },
      ]);

      await createDualPathViaForm("Package Pricer", group, listing);
      // The manual add's sale legs price each path by ITS OWN rule: 2 × 400
      // through the package beside 1 × 1000 standalone — never the listing's
      // base price for the package units.
      expect(await accountBalance(revenueAccount(listing.id))).toBe(1800);
    });

    test("a member without a package override books at the listing's own price", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Plain Kit",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 5,
        name: "Plain Kit Tent",
        unitPrice: 700,
      });
      // No override: the member charges its listing's own price in the bundle.
      await setGroupPackageMembers(group.id, [
        { listingId: listing.id, price: null },
      ]);

      const attendeeId = await createViaForm("Plain Pricer", listing.id, [
        { eventId: listing.id, packageGroupId: group.id, quantity: 1 },
      ]);
      await expectPaths(attendeeId, listing.id, [[group.id, 1]]);
      expect(await accountBalance(revenueAccount(listing.id))).toBe(700);
    });

    test("a crafted package id that is not a real membership books standalone", async () => {
      // A package deleted mid-edit (or a hand-crafted POST) must not mint a
      // row tagged with a package that does not contain the listing.
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
        name: "No Kit",
      });
      const attendeeId = await createViaForm("Crafted", listing.id, [
        { eventId: listing.id, packageGroupId: 99999, quantity: 1 },
      ]);
      await expectPaths(attendeeId, listing.id, [[0, 1]]);
    });
  },
);
