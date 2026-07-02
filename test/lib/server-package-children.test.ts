import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { queryAll } from "#shared/db/client.ts";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectPackageBookingAccepted,
  expectRedirect,
  mockRequest,
  setupStripe,
  signMeta,
  submitPackageBooking,
} from "#test-utils";

/** The REAL booking rows for a listing (a refunded order's quantity-0
 * placeholder is not a booking), newest first, with their parent allocation. */
const bookingRows = (
  listingId: number,
): Promise<
  { quantity: number; package_group_id: number; parent_listing_id: number }[]
> =>
  queryAll(
    `SELECT quantity, package_group_id, parent_listing_id FROM listing_attendees
      WHERE listing_id = ? AND quantity > 0 ORDER BY id DESC`,
    [listingId],
  );

/** A visible two-member package whose first member gates a two-child choice
 * (two children so the page renders per-unit selects — a sole child renders the
 * informational auto-fill block instead). */
const packageWithChild = async (name: string, slug: string) => {
  const group = await createTestGroup({ isPackage: true, name, slug });
  const parent = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} Parent`,
    unitPrice: 1000,
  });
  const other = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} Other`,
    unitPrice: 500,
  });
  const child = await createTestListing({
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} Addon`,
    unitPrice: 300,
  });
  const childB = await createTestListing({
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} Addon B`,
    unitPrice: 400,
  });
  await setChildIds(parent.id, [child.id, childB.id]);
  return { child, childB, group, other, parent };
};

/** A retrieved-session stub for one paid package+child order (members 1000 +
 * 500, one 300 child folded under the first member). */
const packageChildSession = (
  ids: { child: number; group: number; other: number; parent: number },
  sessionId: string,
  intentId: string,
) =>
  ({
    amount_total: 1800,
    id: sessionId,
    metadata: signMeta(
      {
        allocations: JSON.stringify([
          { childId: ids.child, parentId: ids.parent, qty: 1 },
        ]),
        email: `${sessionId}@example.com`,
        items: JSON.stringify([
          { e: ids.parent, k: "p", p: 1000, q: 1, r: ids.group },
          { e: ids.other, k: "p", p: 500, q: 1, r: ids.group },
          { e: ids.child, p: 300, q: 1 },
        ]),
        name: "Kit Payer",
        package_group_id: String(ids.group),
      },
      1800,
    ),
    payment_intent: intentId,
    payment_status: "paid",
  }) as unknown as Awaited<
    ReturnType<typeof stripeApi.retrieveCheckoutSession>
  >;

describeWithEnv("packages with buyer-choice children", { db: true }, () => {
  test("the package page renders the member's child selectors", async () => {
    const { child, childB, group, parent } = await packageWithChild(
      "Kit",
      "kit-child-pkg",
    );
    const body = await (
      await handleRequest(mockRequest(`/ticket/${group.slug}`))
    ).text();
    // The member row carries the same per-unit child controls a standalone
    // parent page renders, naming each child.
    expect(body).toContain(`name="child_qty_${parent.id}_${child.id}"`);
    expect(body).toContain(`name="child_qty_${parent.id}_${childB.id}"`);
    expect(body).toContain("Kit Addon");
    expect(body).toContain('name="package_quantity"');
  });

  test("a free package booking folds the chosen child under its member", async () => {
    const { child, group, other, parent } = await packageWithChild(
      "Free Kit",
      "free-kit-pkg",
    );
    // Zero every price so the booking completes without a provider.
    const { setGroupPackageMembers } = await import("#shared/db/groups.ts");
    const { updateTestListing } = await import("#test-utils");
    await updateTestListing(child.id, { unitPrice: 0 });
    await setGroupPackageMembers(group.id, [
      { listingId: parent.id, price: 0 },
      { listingId: other.id, price: 0 },
    ]);

    const submit = await submitPackageBooking(group.slug, {
      [`child_qty_${parent.id}_${child.id}`]: "1",
      email: "kids@test.com",
      name: "Kit Buyer",
      package_quantity: "1",
    });
    await expectPackageBookingAccepted(submit);

    for (const member of [parent, other]) {
      const rows = await bookingRows(member.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quantity).toBe(1);
      expect(Number(rows[0]!.package_group_id)).toBe(group.id);
    }
    const childRow = (await bookingRows(child.id))[0]!;
    expect(childRow.quantity).toBe(1);
    // The child folded under ITS parent member, not the package at large.
    expect(Number(childRow.parent_listing_id)).toBe(parent.id);
  });

  test("/calculate prices member lines × package count and the child mix exactly once", async () => {
    const { postCalculate } = await import("#test-utils/parents.ts");
    const { child, childB, group, parent } = await packageWithChild(
      "Priced Kit",
      "priced-kit-pkg",
    );
    // Two packages: members (1000 + 500) × 2; the parent's 2 units need a
    // 2-unit child mix, priced per chosen unit — 300 + 400 — never × packageQty
    // again. Total £37.
    const fragment = await postCalculate(group.slug, {
      [`child_qty_${parent.id}_${child.id}`]: "1",
      [`child_qty_${parent.id}_${childB.id}`]: "1",
      package_quantity: "2",
    });
    expect(fragment).toContain("£37");
  });

  test("a paid package books the folded child on the signed allocation", async () => {
    await setupStripe();
    const { child, group, other, parent } = await packageWithChild(
      "Paid Kit",
      "paid-kit-pkg",
    );
    const mockRetrieve = (await import("@std/testing/mock")).stub(
      stripeApi,
      "retrieveCheckoutSession",
      () =>
        Promise.resolve(
          packageChildSession(
            {
              child: child.id,
              group: group.id,
              other: other.id,
              parent: parent.id,
            },
            "cs_pkg_child_paid",
            "pi_pkg_child_paid",
          ),
        ),
    );

    try {
      const redirectResponse = await handleRequest(
        mockRequest("/payment/success?session_id=cs_pkg_child_paid"),
      );
      expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);
      const childRow = (await bookingRows(child.id))[0]!;
      expect(childRow.quantity).toBe(1);
      expect(Number(childRow.parent_listing_id)).toBe(parent.id);
    } finally {
      mockRetrieve.restore();
      resetStripeClient();
    }
  });

  test("a child edge removed mid-checkout refunds instead of booking a stale bundle", async () => {
    await setupStripe();
    const { stub } = await import("@std/testing/mock");
    const { child, group, other, parent } = await packageWithChild(
      "Drift Kit",
      "drift-kit-pkg",
    );
    const mockRefund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_drift" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve(
        packageChildSession(
          {
            child: child.id,
            group: group.id,
            other: other.id,
            parent: parent.id,
          },
          "cs_pkg_child_drift",
          "pi_pkg_child_drift",
        ),
      ),
    );

    try {
      // The operator removes the child edge while the customer is paying: the
      // signed child nodeKey no longer resolves, so the order refunds rather
      // than booking a bundle the current config can't represent.
      await setChildIds(parent.id, []);
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_pkg_child_drift"),
      );
      await response.body?.cancel();
      expect(mockRefund.calls.length).toBe(1);
      expect(await bookingRows(child.id)).toHaveLength(0);
      expect(await bookingRows(parent.id)).toHaveLength(0);
    } finally {
      mockRetrieve.restore();
      mockRefund.restore();
      resetStripeClient();
    }
  });
});
