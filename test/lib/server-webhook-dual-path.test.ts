import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { queryAll } from "#shared/db/client.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
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
 * A paid order booking the SAME listing through two paths at once — a package
 * line plus its own standalone line. The refund-placeholder path must keep the
 * per-line package identity: with both placeholders collapsed onto
 * package_group_id 0 they'd share one booking slot, the duplicate gate would
 * refuse the store, and a signed, paid session would crash instead of being
 * saved and refunded (Codex review, PR #1578).
 */
describeWithEnv("server (webhooks) — dual-path refunds", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("stores one placeholder per path and refunds when capacity fails", async () => {
    await setupStripe();
    // One spot only: the two-path order (2 units) can never be honoured.
    const group = await createTestGroup({
      isPackage: true,
      name: "Tight Bundle",
      slug: "tight-bundle",
    });
    const listing = await createTestListing({
      groupId: group.id,
      maxAttendees: 1,
      maxQuantity: 5,
      name: "Tight Tent",
      unitPrice: 1000,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: listing.id, price: 1000 },
    ]);

    const items = JSON.stringify([
      { e: listing.id, k: "p", p: 1000, q: 1, r: group.id },
      { e: listing.id, p: 1000, q: 1 },
    ]);
    const mockVerify = await stubWebhookVerify({
      data: {
        object: {
          amount_total: 2000,
          id: "cs_dual_path",
          metadata: signedMeta(
            { email: "dual@example.com", items, name: "Dual Buyer" },
            2000,
          ),
          payment_intent: "pi_dual_path",
          payment_status: "paid",
        },
      },
      id: "evt_dual_path",
      type: "checkout.session.completed",
    });
    const mockRefund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_dual" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.processed).toBe(false);
          expect(json.error).toContain("saved your details");
        },
      );
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
});
