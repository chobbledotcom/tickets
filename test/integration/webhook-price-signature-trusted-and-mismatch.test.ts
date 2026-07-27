import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingChildren } from "#shared/db/listing-parents.ts";
import {
  expectProcessed,
  expectReplayOutcome,
  expectStoredRefund,
  expectStoredRefundRecord,
  runWebhook,
  setupPackage,
  setupWithListing,
  signedMeta,
} from "#test/lib/webhook-price-signature/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv(
  "webhook signed price oracle — trusted & mismatch",
  { db: true },
  () => {
    test("a faithfully signed session is processed and creates the attendee", async () => {
      const listing = await setupWithListing();
      await runWebhook(
        {
          id: "cs_signed_ok",
          metadata: signedMeta(1000, {
            items: singleItem(listing.id, 1, 1000),
          }),
        },
        () => expectProcessed(listing.id),
      );
    });

    test("a signed session whose _origin was stripped is still processed", async () => {
      const listing = await setupWithListing();
      // _origin is unsigned, so stripping it after signing leaves a valid proof.
      // The proof alone proves the session is ours, regardless of the origin.
      const metadata = {
        ...signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
        _origin: "",
      };
      await runWebhook({ id: "cs_origin_stripped", metadata }, () =>
        expectProcessed(listing.id),
      );
    });

    // ---- mismatch / divergence: store a quantity-0 placeholder, refund, flag ---

    test("a charge that differs from the signed total is stored and refunded", async () => {
      const listing = await setupWithListing();
      // Signed at 1000 but the provider reports a 1200 charge — a mismatch. The
      // payment is ours (signed), so the booking is kept (not dropped into limbo).
      await expectReplayOutcome(
        {
          amount_total: 1200,
          id: "cs_signed_mismatch",
          metadata: signedMeta(1000, {
            items: singleItem(listing.id, 1, 1000),
          }),
        },
        { processed: false, refundCalls: 1 },
      );
      await expectStoredRefundRecord(listing.id);
    });

    test("a re-derivation that diverges from the signed total is stored and refunded", async () => {
      const listing = await setupWithListing();
      // Signed and charged at 999, but the item re-prices to 1000 — a price edit
      // between checkout and webhook. The booking is kept, refunded, and flagged.
      await expectReplayOutcome(
        {
          amount_total: 999,
          id: "cs_signed_diverge",
          metadata: signedMeta(999, { items: singleItem(listing.id, 1, 1000) }),
        },
        { processed: false, refundCalls: 1 },
      );
      await expectStoredRefundRecord(listing.id);
    });

    test("a divergence from a dropped modifier ref is stored and refunded", async () => {
      const listing = await setupWithListing();
      // Signed at 1100 as if a +100 modifier applied, but the referenced modifier
      // no longer resolves, so re-derivation lands at 1000 — stored and refunded.
      const metadata = signedMeta(1100, {
        items: singleItem(listing.id, 1, 1000),
        modifiers: JSON.stringify([{ i: 999999, q: 1 }]),
      });
      await runWebhook(
        { amount_total: 1100, id: "cs_signed_dropped", metadata },
        async (refund) => {
          await expectStoredRefund(listing.id);
          expect(refund.calls.length).toBe(1);
        },
      );
    });

    // ---- signed-edge revalidation ---------------------------------------------

    /** A signed session booking `child` under `parent`: the parent line, the folded
     * child line, and the allocation that maps the child under the parent. */
    const signedParentChild = (
      parentId: number,
      childId: number,
    ): Record<string, string> =>
      signMeta(
        webhookMeta({
          allocations: JSON.stringify([{ childId, parentId, qty: 1 }]),
          email: "buyer@example.com",
          items: JSON.stringify([
            { e: parentId, p: 1000, q: 1 },
            { e: childId, p: 0, q: 1 },
          ]),
          name: "Buyer",
        }),
        1000,
      );

    test("a booking whose signed child edge was re-parented mid-checkout is stored and refunded", async () => {
      // The child is booked under parentA while also a child of parentB, then
      // re-parented so only parentB keeps it: the child stays reachable (so the
      // per-item add-on check passes) but its signed parentA→child edge is gone,
      // which only the nodeKey walk can catch.
      await setupStripe();
      const parentA = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const parentB = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const child = await createTestListing({ maxAttendees: 50, unitPrice: 0 });
      await listingChildren.setIds(parentA.id, [child.id]);
      await listingChildren.setIds(parentB.id, [child.id]);
      const metadata = signedParentChild(parentA.id, child.id);
      await listingChildren.setIds(parentA.id, []);
      await runWebhook({ id: "cs_edge_swap", metadata }, () =>
        expectStoredRefund(parentA.id),
      );
    });

    test("a parent+child booking with intact edges processes (the edge walk finds no drift)", async () => {
      await setupStripe();
      const parent = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const child = await createTestListing({ maxAttendees: 50, unitPrice: 0 });
      await listingChildren.setIds(parent.id, [child.id]);
      const metadata = signedParentChild(parent.id, child.id);
      await runWebhook({ id: "cs_edge_intact", metadata }, () =>
        expectProcessed(parent.id),
      );
    });

    test("a package booking with a matching bundle processes (the edge walk finds no drift)", async () => {
      const { group, listing } = await setupPackage();
      // A package line carries its edge (k:"p", r=group id); the walk rebuilds the
      // package tree, finds the member's nodeKey resolves, and books it.
      const metadata = signMeta(
        webhookMeta({
          email: "buyer@example.com",
          items: JSON.stringify([
            { e: listing.id, k: "p", p: 1500, q: 1, r: group.id },
          ]),
          name: "Buyer",
        }),
        1500,
      );
      await runWebhook(
        { amount_total: 1500, id: "cs_pkg_edge_ok", metadata },
        () => expectProcessed(listing.id),
      );
    });
  },
);
