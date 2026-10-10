/**
 * Discovery/share-surface suppression for the listing parent/child feature:
 * the "Other entry points" and "no bookable child ⇒ sold out" behaviours.
 * A *visible* child must never advertise a standalone `/ticket/<slug>`
 * entry point, and a parent with no bookable child must read as sold out, on
 * every discovery surface: public cards, RSS/ICS feeds, the /order gallery, the
 * admin multi-booking link builder, and the per-listing share/QR generators.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingChildren } from "#db/listing-parents.ts";
import { classifyForDiscovery } from "#routes/public/discovery.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  makeParent,
  makeRoomySharedChild,
  publicBody,
  ticketPageStatus,
} from "#test-utils/parents.ts";
import {
  assertAddOnNote,
  assertBookable,
  assertSoldOut,
  makeDefaultParentChild,
  makeTwoSpotPool,
  setupOneSpotPool,
  setupSoldOutChild,
} from "./discovery-helpers.ts";

describeWithEnv(
  "listing parent discovery",
  { db: true, triggers: true },
  () => {
    describe("public listing cards (/listings)", () => {
      test("a visible child card has no standalone Book link", async () => {
        const { parent, child } = await makeDefaultParentChild();
        const body = await publicBody("/listings");
        // The child's card is still shown, but with no /ticket/<child> CTA.
        expect(body).toContain("Add-on");
        expect(body).not.toContain(`href="/ticket/${child.slug}"`);
        expect(body).toContain("Available as an add-on to another booking");
        // The parent keeps its normal Book link.
        expect(body).toContain(`href="/ticket/${parent.slug}"`);
      });

      test("a child sold alone keeps its Book link and has no add-on note", async () => {
        const { child } = await makeParent({
          children: [{ bookableAlone: true, name: "Standalone child" }],
          parent: { name: "Base unit" },
        });

        const body = await publicBody("/listings");
        expect(body).toContain(`href="/ticket/${child.slug}"`);
        expect(body).not.toContain("Available as an add-on to another booking");
      });

      test("a parent whose only child is sold out renders sold out", async () => {
        const { parent } = await setupSoldOutChild();
        await assertSoldOut(parent.slug);
      });

      test("a daily child under a daily parent folds on a date both offer", async () => {
        // The per-date fold check: the child must start on the very date the
        // parent's calendar offers, and hold it for the span that date books.
        // This is the gate the date-less evaluation cannot answer.
        const { parent } = await makeParent({
          children: [{ daily: true, name: "Daily add-on" }],
          parent: { daily: true, name: "Daily base" },
        });
        await assertBookable(parent.slug);
      });

      test("a parent whose only child has closed registration is sold out", async () => {
        const pastDate = new Date(Date.now() - 60000)
          .toISOString()
          .slice(0, 16);
        const { parent } = await makeParent({
          children: [{ closesAt: pastDate, name: "Add-on" }],
          parent: { name: "Base unit" },
        });
        await assertSoldOut(parent.slug);
      });

      test("a parent with one bookable child keeps its Book link", async () => {
        const { parent } = await makeDefaultParentChild();
        await assertBookable(parent.slug);
      });

      // A child whose only parent cannot offer it (deactivated / sold out /
      // closed registration) has a dead-end "available as an add-on" CTA and is
      // never standalone-bookable (the slug guard rejects all children), so its
      // card must read as currently unavailable rather than a dead-end Book link
      // or add-on note (parentBookable). Each row disables the only parent
      // a different way; the assertions are identical.
      const UNAVAILABLE_CHILD_CASES: {
        name: string;
        // Build the parent + child for this row and disable the parent.
        setup: () => Promise<{ child: { slug: string } }>;
      }[] = [
        {
          name: "a child whose only parent is deactivated renders unavailable",
          setup: async () => {
            const { parent, child } = await makeParent({
              children: [{ name: "Add-on" }],
              parent: { name: "Base unit" },
            });
            await deactivateTestListing(parent.id);
            return { child };
          },
        },
        {
          name: "a child whose only parent is sold out renders unavailable",
          setup: async () => {
            const { parent, child } = await makeParent({
              children: [{ name: "Add-on" }],
              parent: { maxAttendees: 1, name: "Base unit" },
            });
            await createTestAttendee(
              parent.id,
              parent.slug,
              "Buyer",
              "b@x.com",
            );
            return { child };
          },
        },
        {
          name: "a child whose only parent has closed registration renders unavailable",
          setup: async () => {
            const pastDate = new Date(Date.now() - 60000)
              .toISOString()
              .slice(0, 16);
            const { child } = await makeParent({
              children: [{ name: "Add-on" }],
              parent: { closesAt: pastDate, name: "Base unit" },
            });
            return { child };
          },
        },
      ];
      for (const c of UNAVAILABLE_CHILD_CASES) {
        test(c.name, async () => {
          const { child } = await c.setup();
          const body = await publicBody("/listings");
          expect(body).toContain("Add-on");
          expect(body).not.toContain(
            "Available as an add-on to another booking",
          );
          expect(body).not.toContain(`href="/ticket/${child.slug}"`);
          expect(body).toContain("Currently Unavailable");
        });
      }

      test("a child whose only parent is deactivated still 404s its ticket page", async () => {
        // The slug guard rejects every child regardless of parent.active, so the
        // advertised-as-unavailable child must not be standalone-bookable.
        const { parent, child } = await makeDefaultParentChild();
        await deactivateTestListing(parent.id);
        expect(await ticketPageStatus(child.slug)).toBe(404);
      });

      test("a child with a bookable parent shows the add-on note", async () => {
        // The parent is active, not sold out, and not closed, so it can fold the
        // child into a booking — the child's card shows the add-on note and the
        // child's own standalone CTA stays suppressed (parentBookable
        // bookable case).
        const { child } = await makeDefaultParentChild();
        await assertAddOnNote(child.slug);
      });

      test("a child with one active and one inactive parent stays labeled add-on", async () => {
        // At least one active parent can still offer the child, so the standalone
        // CTA must stay suppressed.
        const activeParent = await createTestListing({ name: "Active base" });
        const deadParent = await createTestListing({ name: "Dead base" });
        const child = await createTestListing({ name: "Add-on" });
        await listingChildren.setIds(activeParent.id, [child.id]);
        await listingChildren.setIds(deadParent.id, [child.id]);
        await deactivateTestListing(deadParent.id);
        await assertAddOnNote(child.slug);
      });

      test("a sold-out visible child shows sold out, not the add-on note", async () => {
        // The unavailable state must take precedence over the add-on note so the
        // card does not advertise an add-on the gate would reject.
        await setupSoldOutChild();
        const body = await publicBody("/listings");
        expect(body).toContain("Add-on");
        expect(body).toContain("Sold Out");
        expect(body).not.toContain("Available as an add-on to another booking");
      });

      test("a parent + child sharing a capped group with 1 spot is sold out", async () => {
        // Parent and its only child share a capped group, so the minimum order
        // (one parent + one auto-selected child) consumes TWO group spots. With
        // one spot left, the parent reads sold out even though the child looks
        // individually bookable (combined demand).
        const { parent } = await setupOneSpotPool();
        await assertSoldOut(parent.slug);
      });

      test("a parent + child sharing a capped group with 2 spots is bookable", async () => {
        // With two spots free, the combined parent+child demand fits, so the
        // parent keeps its Book link.
        const { parent } = await makeTwoSpotPool();
        await assertBookable(parent.slug);
      });

      test("a parent whose children combine to its minimum is bookable", async () => {
        // The booking page splits a parent's quantity across its children (the
        // child quantities must sum to it), so no single child has to serve the
        // whole minimum: two seats on one child plus one on another reach a
        // minimum of three.
        const { parent } = await makeParent({
          children: [
            { maxAttendees: 2, maxQuantity: 2, name: "Two-seat add-on" },
            { maxAttendees: 1, maxQuantity: 1, name: "One-seat add-on" },
          ],
          parent: { maxQuantity: 3, minQuantity: 3, name: "Base unit" },
        });
        await assertBookable(parent.slug);
      });

      test("two children sharing one capped group below the parent minimum are sold out", async () => {
        // Both children draw parent+child pairs from the SAME pool, so the pool
        // bounds the parent tickets once: two free spots serve one pair, and a
        // minimum of three can never be met. The combined capacity must not
        // count the shared pool once per child.
        const { parent } = await makeParent({
          children: [
            { maxAttendees: 3, maxQuantity: 3, name: "Left add-on" },
            { maxAttendees: 3, maxQuantity: 3, name: "Right add-on" },
          ],
          group: { maxAttendees: 4, name: "Shared pool" },
          parent: { maxQuantity: 3, minQuantity: 3, name: "Base unit" },
        });
        await assertSoldOut(parent.slug);
      });

      test("a child is not an add-on of a parent its children cannot serve", async () => {
        // The parent's minimum is three but its only child can serve two: no
        // split of this one child reaches the minimum, so the add-on note would
        // point at a parent no one can book.
        const { child, parent } = await makeParent({
          children: [
            { maxAttendees: 2, maxQuantity: 2, name: "Two-seat add-on" },
          ],
          parent: { maxQuantity: 3, minQuantity: 3, name: "Base unit" },
        });
        const body = await publicBody("/listings");
        expect(body).not.toContain("Available as an add-on to another booking");
        expect(body).toContain(parent.name);
        expect(body).toContain(child.name);
      });

      test("a child in a roomy SHARED group is bookable despite a tighter NON-shared group", async () => {
        // The child belongs to the parent's capped group A (10 spots) AND its own
        // tighter capped group B (1 spot). The combined-demand check must use the
        // SHARED group's remaining (A = 10), not the child's tightest group overall
        // (B = 1): one parent+child order needs two of A's ten spots, so it fits and
        // the parent keeps its Book link. The pre-fix code took the child's
        // per-listing minimum (1) and marked the parent sold out.
        const { parent } = await makeRoomySharedChild();
        await assertBookable(parent.slug);
      });

      test("a parent whose minimum exceeds what its children can serve is sold out", async () => {
        // The parent sells at least 3 per purchase, but its only child can
        // serve 2 parent tickets. No child serves the minimum, so the gallery
        // must read the parent sold out — the API detail projects the same
        // classification, so a client never books a below-minimum quantity.
        const { parent } = await makeParent({
          children: [{ maxQuantity: 2, name: "Two-ticket add-on" }],
          parent: {
            maxQuantity: 10,
            minQuantity: 3,
            name: "Bulk base unit",
          },
        });
        await assertSoldOut(parent.slug);
      });

      test("a parent whose minimum is served by a child stays bookable", async () => {
        // Same shape with a child that serves the parent minimum: the Book link
        // must survive the new minimum check.
        const { parent } = await makeParent({
          children: [{ maxQuantity: 5, name: "Wide add-on" }],
          parent: {
            maxQuantity: 10,
            minQuantity: 3,
            name: "Bulk bookable unit",
          },
        });
        await assertBookable(parent.slug);
      });

      test("a parent + child in different capped groups stays bookable", async () => {
        // When parent and child sit in different capped groups they do not share
        // a pool, so the combined-demand check does not apply and the per-row
        // check stands — the parent keeps its Book link (non-shared case).
        const groupA = await createTestGroup({
          maxAttendees: 5,
          name: "PoolA",
        });
        const groupB = await createTestGroup({
          maxAttendees: 5,
          name: "PoolB",
        });
        const parent = await createTestListing({
          groupId: groupA.id,
          name: "Base unit",
        });
        const child = await createTestListing({
          groupId: groupB.id,
          name: "Add-on",
        });
        await listingChildren.setIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).toContain(`href="/ticket/${parent.slug}"`);
      });

      test("a child whose only parent shares a 1-spot capped group is not labeled add-on", async () => {
        // The child's only parent shares a capped group with it, so the minimum
        // parent+child order needs two spots. With one spot left the parent is
        // projected sold out, so the add-on note would be a dead end — the child
        // must read unavailable, NOT "available as an add-on" (addOnChildIds
        // must use the same combined-demand check as the parent sold-out
        // projection).
        await setupOneSpotPool();
        const body = await publicBody("/listings");
        expect(body).toContain("Add-on");
        expect(body).not.toContain("Available as an add-on to another booking");
      });

      test("a child whose only parent shares a 2-spot capped group shows the add-on note", async () => {
        // Two spots free ⇒ the combined parent+child demand fits, so the parent
        // can offer the child and the add-on note appears.
        const { child } = await makeTwoSpotPool();
        await assertAddOnNote(child.slug);
      });

      test("a child offered only where the minimum cannot be met is not labeled add-on", async () => {
        // The parent sells at least three per purchase and books on Mondays
        // and Tuesdays. This child folds on Mondays alone and holds one
        // place; its sibling folds on Tuesdays alone and holds three.
        // Tuesday serves the minimum, so the parent keeps its Book link, but
        // no Monday booking reaches three, so this child can never join one.
        // Two independent existential checks — the parent's combined capacity
        // on one date, this child's fold check on another — would label the
        // child a dead end. The classification is asserted per child because
        // the sibling's own label is correct and would trip a page-wide
        // string check.
        const { child, children, parent } = await makeParent({
          children: [
            {
              bookableDays: ["Monday"],
              daily: true,
              maxAttendees: 1,
              maxQuantity: 1,
              name: "Monday extra",
            },
            {
              bookableDays: ["Tuesday"],
              daily: true,
              maxAttendees: 3,
              maxQuantity: 3,
              name: "Tuesday bulk",
            },
          ],
          parent: {
            bookableDays: ["Monday", "Tuesday"],
            daily: true,
            maxQuantity: 3,
            minQuantity: 3,
            name: "Batched base",
          },
        });
        const [mondayExtra, tuesdayBulk] = children;
        const { addOnChildIds, soldOutParentIds } = await classifyForDiscovery([
          parent,
          ...children,
        ]);
        expect(soldOutParentIds.has(parent.id)).toBe(false);
        expect(addOnChildIds.has(tuesdayBulk!.id)).toBe(true);
        expect(addOnChildIds.has(mondayExtra!.id)).toBe(false);
        expect(addOnChildIds.has(child.id)).toBe(false);
        const body = await publicBody("/listings");
        expect(body).toContain(`href="/ticket/${parent.slug}"`);
      });
    });
  },
);
