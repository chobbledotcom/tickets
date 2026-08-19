// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { deactivateTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  bookParent,
  expectNoBooking,
  expectRejectedBooking,
  expectReserved,
  makeParent,
  parentField,
} from "#test-utils/parents.ts";
import { stubCheckoutIntent } from "#test-utils/parents-gate/helpers.ts";

// jscpd:ignore-end

describeWithEnv(
  "server > parents gate > questions & thank-you URL",
  { db: true, triggers: true },
  () => {
    test("a parent's configured thank-you URL survives folding a child", async () => {
      const { parent } = await makeParent({
        parent: { thankYouUrl: "https://example.com/thanks-parent" },
      });

      const res = await bookParent(parent.slug, parentField(parent, "1"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://example.com/thanks-parent",
      );
    });

    test("a paid parent's thank-you URL is carried into the checkout intent", async () => {
      // The paid path folds a required paid child, making the order
      // multi-listing; the webhook's single-listing thank-you derivation would
      // drop the parent's URL, so it must be set explicitly on the intent.
      // Capture the intent handed to the provider and assert it.
      const { checkout, getCaptured } =
        await stubCheckoutIntent("cs_parent_paid");

      const { parent } = await makeParent({
        children: [{ maxAttendees: 50, unitPrice: 1000 }],
        parent: {
          maxAttendees: 50,
          thankYouUrl: "https://example.com/thanks-parent",
          unitPrice: 1000,
        },
      });

      try {
        const res = await bookParent(parent.slug, parentField(parent, "1"));
        expect(res.status).toBe(302);
        // The order folded the child (two distinct listings) yet still carries
        // the parent's configured thank-you URL.
        const listingIds = new Set(
          getCaptured()?.items.map((i) => i.listingId),
        );
        expect(listingIds.size).toBe(2);
        expect(getCaptured()?.thankYouUrl).toBe(
          "https://example.com/thanks-parent",
        );
      } finally {
        checkout.restore();
      }
    });

    test("an inactive child makes its parent sold out (rejected)", async () => {
      const { parent, child } = await makeParent({
        parent: { name: "Base unit" },
      });
      // Deactivating the only child leaves the parent with no bookable child.
      await deactivateTestListing(child.id);

      const res = await bookParent(parent.slug, parentField(parent, "1"));
      await expectRejectedBooking(
        res,
        parent.id,
        "Base unit has no available options right now.",
      );
    });

    test("an inactive child is skipped, leaving an active sibling to fold", async () => {
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const [dead, live] = [children[0]!, children[1]!];
      await deactivateTestListing(dead.id);

      // With the inactive child skipped, the live sibling is the sole bookable
      // child and auto-selects.
      const res = await bookParent(parent.slug, parentField(parent, "1"));
      expectReserved(res);
      expect((await getAttendeesRaw(live.id)).length).toBe(1);
      await expectNoBooking(dead);
    });
  },
);
