import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { queryAll } from "#shared/db/client.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { stripeApi } from "#shared/stripe.ts";
import type { Group, Listing } from "#shared/types.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta } from "#test-utils/factories.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { checkoutSessionEvent } from "#test-utils/webhooks.ts";

/**
 * Paid orders booking the SAME listing through two paths at once — a package
 * line plus its own standalone line — exercised through the webhook: the
 * refund-placeholder path must keep per-line package identity (identical
 * slots would crash the store-and-refund), and the stale checks must judge
 * the standalone PATH even though a tagged line shares its listing id.
 */

/** A one-member paid bundle: the member sells for 1000 inside the package. */
const paidBundle = async (
  name: string,
  slug: string,
  memberName: string,
  maxAttendees: number,
): Promise<{ group: Group; listing: Listing }> => {
  const group = await createTestGroup({ isPackage: true, name, slug });
  const listing = await createTestListing({
    groupId: group.id,
    maxAttendees,
    maxQuantity: 5,
    name: memberName,
    unitPrice: 1000,
  });
  await setGroupPackageMembers(group.id, [
    { listingId: listing.id, price: 1000 },
  ]);
  return { group, listing };
};

/** Stub a signed, paid session over the given items/allocations plus the
 * provider's refund call. Callers restore both stubs. */
const paidSession = async (
  ref: string,
  total: number,
  fields: { items: string; allocations?: string },
  email: string,
  buyer: string,
) => {
  const mockVerify = await stubWebhookVerify(
    checkoutSessionEvent({
      amountTotal: total,
      eventId: `evt_${ref}`,
      metadata: signedMeta({ email, name: buyer, ...fields }, total),
      paymentIntent: `pi_${ref}`,
      sessionId: `cs_${ref}`,
    }),
  );
  const mockRefund = stub(stripeApi, "requestRefund", () =>
    Promise.resolve({
      id: `re_${ref}`,
      status: "succeeded",
    } as unknown as Awaited<ReturnType<typeof stripeApi.requestRefund>>),
  );
  return { mockRefund, mockVerify };
};

/** A signed, paid dual-path session for the listing: its bundle line plus its
 * own standalone line. */
const dualPathSession = (
  ref: string,
  group: Group,
  listing: Listing,
  email: string,
  buyer: string,
) =>
  paidSession(
    ref,
    2000,
    {
      items: JSON.stringify([
        { e: listing.id, k: "p", p: 1000, q: 1, r: group.id },
        { e: listing.id, p: 1000, q: 1 },
      ]),
    },
    email,
    buyer,
  );

/** Assert the listing's stored rows, one [package_group_id, quantity] pair
 * per row in package-id order — the per-path record the store must keep. */
const expectPathRows = async (
  listingId: number,
  expected: [number, number][],
): Promise<void> => {
  const rows = await queryAll<{
    package_group_id: number;
    quantity: number;
  }>(
    `SELECT package_group_id, quantity FROM listing_attendees
      WHERE listing_id = ? ORDER BY package_group_id ASC`,
    [listingId],
  );
  expect(
    rows.map((row) => [Number(row.package_group_id), row.quantity]),
  ).toEqual(expected);
};

/** Run a dual-path session's refusal epilogue: the webhook answers
 * saved-and-refunded, the listing keeps one quantity-0 placeholder per path,
 * exactly one refund fires — and both stubs are restored either way. */
const expectDualPathRefused = async (
  listing: Listing,
  group: Group,
  stubs: Awaited<ReturnType<typeof paidSession>>,
): Promise<void> => {
  try {
    await expectSavedAndRefunded();
    await expectPathRows(listing.id, [
      [0, 0],
      [group.id, 0],
    ]);
    expect(stubs.mockRefund.calls.length).toBe(1);
  } finally {
    stubs.mockVerify.restore();
    stubs.mockRefund.restore();
  }
};

/** POST the webhook and expect the saved-and-refunded terminal outcome. */
const expectSavedAndRefunded = () =>
  assertJson(
    handleRequest(mockWebhookRequest({}, { "stripe-signature": "sig_valid" })),
    200,
    (json) => {
      expect(json.processed).toBe(false);
      expect(json.error).toContain("saved your details");
    },
  );

describeWithEnv("server (webhooks) — dual-path refunds", { db: true }, () => {
  test("stores one placeholder per path and refunds when capacity fails", async () => {
    await setupStripe();
    // One spot only: the two-path order (2 units) can never be honoured.
    const { group, listing } = await paidBundle(
      "Tight Bundle",
      "tight-bundle",
      "Tight Tent",
      1,
    );
    const stubs = await dualPathSession(
      "dual_path",
      group,
      listing,
      "dual@example.com",
      "Dual Buyer",
    );

    // The booking is kept as quantity-0 placeholders — one per PATH, each
    // remembering which path it was — and the payment refunded once.
    await expectDualPathRefused(listing, group, stubs);
  });

  test("a listing gone hidden mid-checkout refuses its standalone path", async () => {
    await setupStripe();
    const { group, listing } = await paidBundle(
      "Quiet Bundle",
      "quiet-bundle",
      "Quiet Tent",
      10,
    );
    // Signed while the package showed its members…
    const stubs = await dualPathSession(
      "stale_dual",
      group,
      listing,
      "stale@example.com",
      "Stale Buyer",
    );
    // …then the operator hides them mid-checkout: the standalone page now
    // 404s, so the untagged path must fail the stale check even though a
    // tagged line shares its listing id — saved and refunded (one quantity-0
    // placeholder per path), never a standalone ticket for a concealed
    // listing.
    const { groups } = await import("#shared/db/groups.ts");
    await groups.table.update(group.id, { hidePackageListings: true });

    await expectDualPathRefused(listing, group, stubs);
  });

  test("a non-first line deleted mid-checkout keeps a ghost for EVERY signed line", async () => {
    await setupStripe();
    const { group, listing } = await paidBundle(
      "Ghost Bundle",
      "ghost-bundle",
      "Ghost Tent",
      10,
    );
    const doomed = await createTestListing({
      maxAttendees: 10,
      name: "Doomed Extra",
      unitPrice: 500,
    });
    const { mockRefund, mockVerify } = await paidSession(
      "ghost_lines",
      1500,
      {
        items: JSON.stringify([
          { e: listing.id, k: "p", p: 1000, q: 1, r: group.id },
          { e: doomed.id, p: 500, q: 1 },
        ]),
      },
      "ghost@example.com",
      "Ghost Buyer",
    );
    // The SECOND line's listing vanishes while the buyer pays. The stored
    // operator record must keep one quantity-0 ghost per signed line — the
    // bundle line under its package id and the deleted line under its own id —
    // never a single ghost pinned to the first item's (surviving) listing.
    const { deleteListing } = await import("#shared/db/listings/delete.ts");
    await deleteListing(doomed.id);

    try {
      await expectSavedAndRefunded();
      const rows = await queryAll<{
        listing_id: number;
        package_group_id: number;
        quantity: number;
      }>(
        `SELECT listing_id, package_group_id, quantity FROM listing_attendees
          WHERE listing_id IN (?, ?) ORDER BY listing_id ASC`,
        [listing.id, doomed.id],
      );
      expect(
        rows.map((row) => [
          Number(row.listing_id),
          Number(row.package_group_id),
          row.quantity,
        ]),
      ).toEqual([
        [listing.id, group.id, 0],
        [doomed.id, 0, 0],
      ]);
      expect(mockRefund.calls.length).toBe(1);
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
  });

  test("a paid order folding a child AND buying its surplus standalone books both paths", async () => {
    await setupStripe();
    const parent = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 5,
      name: "Plain Parent",
      unitPrice: 1000,
    });
    const addon = await createTestListing({
      bookableAlone: true,
      maxAttendees: 10,
      maxQuantity: 5,
      name: "Plain Addon",
      thankYouUrl: "",
      unitPrice: 300,
    });
    const { listingChildren } = await import("#shared/db/listing-parents.ts");
    await listingChildren.setIds(parent.id, [addon.id]);
    const { mockRefund, mockVerify } = await paidSession(
      "legit_surplus",
      1900,
      {
        allocations: JSON.stringify([
          { childId: addon.id, parentId: parent.id, qty: 1 },
        ]),
        items: JSON.stringify([
          { e: parent.id, p: 1000, q: 1 },
          { e: addon.id, p: 900, q: 3 },
        ]),
      },
      "legit@example.com",
      "Legit Buyer",
    );

    try {
      // One addon unit folds under the parent, two book standalone — a
      // legitimate combination with stock for all of it. The webhook's drift
      // walk must account for the aggregated line's standalone surplus and
      // BOOK the order, never refund it.
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.received).toBe(true);
        },
      );
      const rows = await queryAll<{
        parent_listing_id: number;
        quantity: number;
      }>(
        `SELECT parent_listing_id, quantity FROM listing_attendees
          WHERE listing_id = ? ORDER BY parent_listing_id ASC`,
        [addon.id],
      );
      expect(
        rows.map((row) => [Number(row.parent_listing_id), row.quantity]),
      ).toEqual([
        [0, 2],
        [parent.id, 1],
      ]);
      expect(mockRefund.calls.length).toBe(0);
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
  });

  test("surplus standalone units of a folded child fail closed when its flag clears", async () => {
    await setupStripe();
    const group = await createTestGroup({
      isPackage: true,
      name: "Slot Bundle",
      slug: "slot-bundle",
    });
    const parent = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 5,
      name: "Slot Parent",
      unitPrice: 1000,
    });
    const addon = await createTestListing({
      bookableAlone: true,
      maxAttendees: 10,
      maxQuantity: 5,
      name: "Slot Addon",
      thankYouUrl: "",
      unitPrice: 300,
    });
    const { listingChildren } = await import("#shared/db/listing-parents.ts");
    await listingChildren.setIds(parent.id, [addon.id]);
    await setGroupPackageMembers(group.id, [
      { listingId: parent.id, price: 1000 },
    ]);
    const { mockRefund, mockVerify } = await paidSession(
      "surplus_child",
      1900,
      {
        allocations: JSON.stringify([
          { childId: addon.id, parentId: parent.id, qty: 1 },
        ]),
        items: JSON.stringify([
          { e: parent.id, k: "p", p: 1000, q: 1, r: group.id },
          { e: addon.id, p: 900, q: 3 },
        ]),
      },
      "surplus@example.com",
      "Surplus Buyer",
    );
    // One addon unit folds under the bundle's parent; two more ride standalone
    // on the SAME aggregated line. The operator clears "can be booked by
    // itself" mid-payment: those standalone units now lead to a 404 page, so
    // the order must be saved-and-refunded — the package allocation must not
    // exempt the line's surplus from the stale check.
    const { listingsTable } = await import("#shared/db/listings/records.ts");
    await listingsTable.update(addon.id, { bookableAlone: false });

    try {
      await expectSavedAndRefunded();
      // The addon keeps exactly one quantity-0 placeholder for its aggregated
      // line — a plain (package-less) slot.
      await expectPathRows(addon.id, [[0, 0]]);
      expect(mockRefund.calls.length).toBe(1);
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
  });
});
