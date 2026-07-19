import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  expectProcessed,
  expectStoredRefund,
  packageMetadata,
  runWebhook,
  setupPackage,
  signedMeta,
} from "../../../lib/webhook-price-signature/helpers.ts";

describeWithEnv(
  "webhook signed price oracle — hidden & standalone members",
  { db: true },
  () => {
    /** A parent "Picker" with one bookable_alone "Solo Widget" child (£10). */
    const parentWithBookableAloneChild = async () => {
      const parent = await createTestListing({ name: "Picker" });
      const child = await createTestListing({
        bookableAlone: true,
        maxAttendees: 50,
        name: "Solo Widget",
        unitPrice: 1000,
      });
      await listingChildren.setIds(parent.id, [child.id]);
      return { child, parent };
    };

    /** A paid parent with a now-un-bookable_alone free child, plus signed
     * metadata folding one child unit under the parent while booking `childQty`
     * child units in total. */
    const foldedChildOrder = async (childQty: number) => {
      const parent = await createTestListing({
        maxAttendees: 50,
        name: "Picker",
        unitPrice: 1000,
      });
      const child = await createTestListing({
        bookableAlone: true,
        maxAttendees: 50,
        name: "Solo Widget",
        unitPrice: 0,
      });
      await listingChildren.setIds(parent.id, [child.id]);
      await listingsTable.update(child.id, { bookableAlone: false });
      const metadata = signMeta(
        webhookMeta({
          allocations: JSON.stringify([
            { childId: child.id, parentId: parent.id, qty: 1 },
          ]),
          email: "buyer@example.com",
          items: JSON.stringify([
            { e: parent.id, p: 1000, q: 1 },
            { e: child.id, p: 0, q: childQty },
          ]),
          name: "Buyer",
        }),
        1000,
      );
      return { child, metadata, parent };
    };

    test("a hidden package booking completes (member name never leaks in the flow)", async () => {
      const { group, listing } = await setupPackage();
      await groups.table.update(group.id, { hidePackageListings: true });
      // A normal hidden-package session: it processes, exercising the path that
      // suppresses member names in any failure message for hidden packages.
      await runWebhook(
        {
          amount_total: 1500,
          id: "cs_pkg_hidden_ok",
          metadata: packageMetadata(group.id, listing.id, 1500),
        },
        () => expectProcessed(listing.id),
      );
    });

    test("a standalone session for a now-hidden package member is refunded, not booked", async () => {
      const { group, listing } = await setupPackage();
      // The buyer started a STANDALONE (non-package) checkout at the base price;
      // the operator then hid the package. Completing it would book a leaking
      // standalone ticket whose /ticket/<slug> 404s, so it must refund instead.
      await groups.table.update(group.id, { hidePackageListings: true });
      await runWebhook(
        {
          amount_total: 5000,
          id: "cs_stale_hidden_member",
          metadata: signedMeta(5000, {
            items: singleItem(listing.id, 1, 5000),
          }),
        },
        async (refund) => {
          await expectStoredRefund(listing.id);
          expect(refund.calls.length).toBe(1);
        },
      );
    });

    test("a standalone session for a child whose bookable_alone was cleared is refunded, not booked", async () => {
      await setupStripe();
      // The child was `bookable_alone` when the buyer opened a STANDALONE checkout
      // for it; the operator then cleared the flag. The parent/child EDGE is
      // unchanged (so orderEdgeDrifted still passes), but the child now has no
      // standalone page — completing it would book a leaking ticket whose
      // /ticket/<slug> 404s. The stale-non-standalone-child guard must fail it
      // closed to a stored refund. Isolates that guard from orderEdgeDrifted.
      const { child } = await parentWithBookableAloneChild();
      await listingsTable.update(child.id, { bookableAlone: false });
      await runWebhook(
        {
          amount_total: 1000,
          id: "cs_stale_bookable_alone",
          metadata: signedMeta(1000, { items: singleItem(child.id, 1, 1000) }),
        },
        async (refund) => {
          await expectStoredRefund(child.id);
          expect(refund.calls.length).toBe(1);
        },
      );
    });

    test("a standalone session for a still-bookable_alone child completes normally", async () => {
      await setupStripe();
      // The contrast: the flag is STILL set, so the standalone child books
      // normally — the guard must not fire on a flag that never changed.
      const { child } = await parentWithBookableAloneChild();
      await runWebhook(
        {
          amount_total: 1000,
          id: "cs_live_bookable_alone",
          metadata: signedMeta(1000, { items: singleItem(child.id, 1, 1000) }),
        },
        async (refund) => {
          await expectProcessed(child.id);
          expect(refund.calls.length).toBe(0);
        },
      );
    });

    test("a mixed folded+standalone child order refunds once the flag clears", async () => {
      await setupStripe();
      // The child was bookable-on-its-own: the buyer booked two units under
      // /ticket/<parent+child> — one folded under the parent (an allocation) and one
      // standalone (the remainder). Clearing the flag strips the standalone unit's
      // page, so the whole order refunds even though a parent is present and the
      // folded unit alone would be fine.
      const { metadata, parent } = await foldedChildOrder(2);
      await runWebhook(
        { amount_total: 1000, id: "cs_stale_remainder", metadata },
        async (refund) => {
          await expectStoredRefund(parent.id);
          expect(refund.calls.length).toBe(1);
        },
      );
    });

    test("a fully-folded child order still completes after the flag clears", async () => {
      await setupStripe();
      // Every child unit is allocated under the parent (no standalone remainder), so
      // clearing the flag leaves nothing standalone to leak — the order completes.
      const { metadata, parent } = await foldedChildOrder(1);
      await runWebhook(
        { amount_total: 1000, id: "cs_folded_after_clear", metadata },
        async (refund) => {
          await expectProcessed(parent.id);
          expect(refund.calls.length).toBe(0);
        },
      );
    });
  },
);
