import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { queryAll } from "#shared/db/client.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import type { Group, Listing } from "#shared/types.ts";
import {
  assertJson,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  stubWebhookVerify,
} from "#test-utils";

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

/** Stub a signed, paid dual-path session for the listing (its bundle line
 * plus its own standalone line) and the provider's refund call. Callers
 * restore both stubs. */
const dualPathSession = async (
  ref: string,
  group: Group,
  listing: Listing,
  email: string,
  buyer: string,
) => {
  const items = JSON.stringify([
    { e: listing.id, k: "p", p: 1000, q: 1, r: group.id },
    { e: listing.id, p: 1000, q: 1 },
  ]);
  const mockVerify = await stubWebhookVerify({
    data: {
      object: {
        amount_total: 2000,
        id: `cs_${ref}`,
        metadata: signedMeta({ email, items, name: buyer }, 2000),
        payment_intent: `pi_${ref}`,
        payment_status: "paid",
      },
    },
    id: `evt_${ref}`,
    type: "checkout.session.completed",
  });
  const mockRefund = stub(stripeApi, "refundPayment", () =>
    Promise.resolve({ id: `re_${ref}` } as unknown as Awaited<
      ReturnType<typeof stripeApi.refundPayment>
    >),
  );
  return { mockRefund, mockVerify };
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
  afterEach(() => {
    resetStripeClient();
  });

  test("stores one placeholder per path and refunds when capacity fails", async () => {
    await setupStripe();
    // One spot only: the two-path order (2 units) can never be honoured.
    const { group, listing } = await paidBundle(
      "Tight Bundle",
      "tight-bundle",
      "Tight Tent",
      1,
    );
    const { mockRefund, mockVerify } = await dualPathSession(
      "dual_path",
      group,
      listing,
      "dual@example.com",
      "Dual Buyer",
    );

    try {
      await expectSavedAndRefunded();
      // The booking is kept as quantity-0 placeholders — one per PATH, each
      // remembering which path it was — and the payment refunded once.
      const rows = await queryAll<{
        package_group_id: number;
        quantity: number;
      }>(
        `SELECT package_group_id, quantity FROM listing_attendees
          WHERE listing_id = ? ORDER BY package_group_id ASC`,
        [listing.id],
      );
      expect(
        rows.map((row) => [Number(row.package_group_id), row.quantity]),
      ).toEqual([
        [0, 0],
        [group.id, 0],
      ]);
      expect(mockRefund.calls.length).toBe(1);
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
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
    const { mockRefund, mockVerify } = await dualPathSession(
      "stale_dual",
      group,
      listing,
      "stale@example.com",
      "Stale Buyer",
    );
    // …then the operator hides them mid-checkout: the standalone page now
    // 404s, so the untagged path must fail the stale check even though a
    // tagged line shares its listing id — saved and refunded, never a
    // standalone ticket for a concealed listing.
    const { groupsTable } = await import("#shared/db/groups.ts");
    await groupsTable.update(group.id, { hidePackageListings: true });

    try {
      await expectSavedAndRefunded();
      const rows = await queryAll<{ quantity: number }>(
        "SELECT quantity FROM listing_attendees WHERE listing_id = ?",
        [listing.id],
      );
      expect(rows.every((row) => row.quantity === 0)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      expect(mockRefund.calls.length).toBe(1);
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
  });
});
