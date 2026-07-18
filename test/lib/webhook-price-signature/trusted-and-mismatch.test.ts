import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { execute } from "#shared/db/client.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { deleteListing } from "#shared/db/listings/delete.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import { isSessionProcessed } from "#shared/db/processed-payments.ts";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  expectProcessed,
  expectReplayOutcome,
  expectStoredRefund,
  expectStoredRefundRecord,
  runWebhook,
  setupPackage,
  setupWithListing,
  signedMeta,
  webhookRequest,
} from "./helpers.ts";

const pruneReplayRowWithoutRefundReference = async (sessionId: string) => {
  await execute(
    `UPDATE processed_payments
        SET processed_at = ?, payment_reference = ''
      WHERE payment_session_id = ?`,
    ["2000-01-01T00:00:00.000Z", sessionId],
  );
  await runDatabasePruning();
  expect(await isSessionProcessed(sessionId)).toBe(null);
};

describeWithEnv(
  "webhook signed price oracle — trusted & mismatch",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

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

    test("a replay whose idempotency row was pruned recovers the booking instead of refunding the live ticket", async () => {
      const listing = await setupWithListing();
      const session = {
        id: "cs_replay_after_prune",
        metadata: signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      };

      // First delivery: a clean processed booking with its sale/payment legs.
      await runWebhook(session, async (refund) => {
        await expectProcessed(listing.id);
        expect(refund.calls.length).toBe(0);
      });
      const [original] = await getAttendeesRaw(listing.id);
      const legsBefore = await transfersByAccount(
        attendeeAccount(original!.id),
      );

      // The ledger legs are permanent, but the processed_payments idempotency row
      // can still be missing after old data cleanup if it no longer carries a
      // useful refund reference. Back-date it and clear that reference so the real
      // pruner reproduces the reachable "legs exist, no idempotency row" replay
      // state.
      await pruneReplayRowWithoutRefundReference(session.id);

      // Second delivery (the replay): the booking + ticket still exist, and there
      // are still 49 free seats, so capacity is not the blocker — only the existing
      // ledger legs are. It must recover the booking, never refund the live ticket
      // nor keep a quantity-0 ghost.
      await expectReplayOutcome(session, { processed: true, refundCalls: 0 });

      // The original booking is intact: one attendee at full quantity, no new or
      // reversing ledger legs, and the idempotency row re-finalized back to it.
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.id).toBe(original!.id);
      expect(attendees[0]!.quantity).toBe(1);
      const legsAfter = await transfersByAccount(attendeeAccount(original!.id));
      expect(legsAfter.length).toBe(legsBefore.length);
      expect(legsAfter.some((leg) => leg.kind === "refund_cash")).toBe(false);
      expect((await isSessionProcessed(session.id))!.attendee_id).toBe(
        original!.id,
      );
    });

    test("a pruned replay whose listing price changed is recovered, not refunded", async () => {
      const listing = await setupWithListing();
      const session = {
        id: "cs_replay_price_changed",
        metadata: signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      };
      await runWebhook(session, () => expectProcessed(listing.id));
      const [original] = await getAttendeesRaw(listing.id);

      // Prune the idempotency row; the permanent ledger legs remain.
      await pruneReplayRowWithoutRefundReference(session.id);
      // The listing price is edited after the booking — exactly the mid-checkout
      // change that makes a late replay re-price differently. Without the ledger
      // preflight this hit paidPricingRefund and refunded the live ticket (P1).
      await listingsTable.update(listing.id, { unitPrice: 1500 });

      await expectReplayOutcome(session, { processed: true, refundCalls: 0 });
      // The original booking is recovered — no refund, no duplicate.
      expect((await getAttendeesRaw(listing.id)).map((a) => a.id)).toEqual([
        original!.id,
      ]);
    });

    test("a pruned replay whose listing was deleted is acknowledged, not refunded", async () => {
      const listing = await setupWithListing();
      const session = {
        id: "cs_replay_listing_deleted",
        metadata: signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      };
      await runWebhook(session, () => expectProcessed(listing.id));

      await pruneReplayRowWithoutRefundReference(session.id);
      // Deleting the listing removes the booking's listing_attendees row (and its
      // ledger_event_group stamp) but leaves the transfers: the event group is now
      // orphaned. Without the preflight this 404'd into a placeholder refund (P1);
      // now the ledger is recognised as already accounting for the money, so we
      // acknowledge without refunding or recreating a ghost.
      await deleteListing(listing.id);

      await runWebhook(session, async (refund) => {
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(false);
          expect(json.error).toContain("already been processed");
        });
        expect(refund.calls.length).toBe(0);
      });
      // No placeholder ghost was created for the orphaned replay.
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
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
