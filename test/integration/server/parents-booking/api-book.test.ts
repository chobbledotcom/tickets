import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  bookableStartDates,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { apiBook, bookParentChild, makeParent } from "#test-utils/parents.ts";
import { enablePublicApi } from "#test-utils/settings.ts";
import type { Listing } from "#types";

describeWithEnv(
  "server > parents booking — JSON API booking",
  { db: true, triggers: true },
  () => {
    test("the JSON API rejects booking a child slug", async () => {
      await enablePublicApi();
      const { child } = await makeParent();
      const res = await apiBook(child.slug);
      expect(res.status).toBe(400);
    });

    test("the JSON API books a free parent with its sole child auto-filled", async () => {
      await enablePublicApi();
      const { parent, child } = await makeParent();
      // No `children` array: the sole bookable child is auto-filled.
      const res = await apiBook(parent.slug);
      expect(res.status).toBe(200);
      const { ticketToken } = (
        (await res.json()) as {
          booking: { ticketToken: string };
        }
      ).booking;
      const { getAttendeesByTokens } = await import("#db/attendees/tokens.ts");
      const [attendee] = await getAttendeesByTokens([ticketToken]);
      const bookings = attendee!.bookings;
      // Both the parent and its child are booked on the one attendee, and the
      // child row is stored linked to its parent (pairing recomputed on save).
      expect(bookings.map((b) => b.listing_id).sort()).toEqual(
        [parent.id, child.id].sort((a, b) => a - b),
      );
      const childBooking = bookings.find((b) => b.listing_id === child.id);
      expect(childBooking?.parent_listing_id).toBe(parent.id);
    });

    test("the JSON API books a parent with an explicit per-unit child mix", async () => {
      await enablePublicApi();
      const { parent, children } = await makeParent({
        children: [{}, {}],
        parent: { maxQuantity: 5 },
      });
      const childA = children[0]!;
      const childB = children[1]!;
      const res = await apiBook(parent.slug, {
        children: [
          { quantity: 1, slug: childA.slug },
          { quantity: 1, slug: childB.slug },
        ],
        quantity: 2,
      });
      expect(res.status).toBe(200);
      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      expect((await getAttendeesRaw(childA.id))[0]?.quantity).toBe(1);
      expect((await getAttendeesRaw(childB.id))[0]?.quantity).toBe(1);
    });

    // Table-driven: the JSON-API rejection cluster. Each row enables the public
    // API, builds a parent, POSTs a body to `apiBook(parent.slug, …)`, and
    // expects a 400. `body` may reference the created child; the two extra
    // assertions some rows carry are optional per-row fields.
    const API_REJECTION_CASES: {
      name: string;
      makeParentArgs?: Parameters<typeof makeParent>[0];
      body: (child: Listing) => Promise<Record<string, unknown>>;
      expectErrorContains?: string;
      expectZeroParentAttendees?: boolean;
    }[] = [
      {
        body: (child) =>
          Promise.resolve({
            children: [{ quantity: 1, slug: child.slug }],
            quantity: 2,
          }),
        // Two parent units but only one child chosen — the fold rejects it.
        expectZeroParentAttendees: true,
        makeParentArgs: { children: [{}, {}], parent: { maxQuantity: 5 } },
        name: "the JSON API rejects a child total below the parent quantity",
      },
      {
        body: async () => {
          const stranger = await createTestListing({ name: "Stranger" });
          return { children: [{ quantity: 1, slug: stranger.slug }] };
        },
        expectErrorContains: "is not a child of this listing",
        name: "the JSON API rejects a child slug that is not a child of the parent",
      },
      {
        body: () => Promise.resolve({ children: "nope" }),
        name: "the JSON API rejects a malformed children field",
      },
      {
        body: (child) =>
          Promise.resolve({
            children: [{ quantity: 1, slug: child.slug }],
          }),
        makeParentArgs: {
          parent: {
            customisableDays: true,
            dayPrices: { 1: 1000, 2: 1800 },
            durationDays: 2,
          },
        },
        name: "the JSON API rejects booking a customisable parent",
      },
      {
        body: () => Promise.resolve({ children: [null] }),
        name: "the JSON API rejects a null children entry",
      },
      {
        body: (child) => Promise.resolve({ children: [{ slug: child.slug }] }),
        name: "the JSON API rejects a children entry missing its quantity",
      },
    ];
    for (const c of API_REJECTION_CASES) {
      test(c.name, async () => {
        await enablePublicApi();
        const { parent, child } = await makeParent(c.makeParentArgs);
        const res = await apiBook(parent.slug, await c.body(child));
        expect(res.status).toBe(400);
        if (c.expectErrorContains !== undefined) {
          const body = (await res.json()) as { error: string };
          expect(body.error).toContain(c.expectErrorContains);
        }
        if (c.expectZeroParentAttendees) {
          const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
          expect((await getAttendeesRaw(parent.id)).length).toBe(0);
        }
      });
    }

    test("the JSON API sums repeated child slugs to the parent quantity", async () => {
      await enablePublicApi();
      const { parent, child } = await makeParent({
        children: [{ maxQuantity: 5 }],
        parent: { maxQuantity: 5 },
      });
      // Two entries for the same child sum to 2, matching the parent quantity.
      const res = await apiBook(parent.slug, {
        children: [
          { quantity: 1, slug: child.slug },
          { quantity: 1, slug: child.slug },
        ],
        quantity: 2,
      });
      expect(res.status).toBe(200);
      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      expect((await getAttendeesRaw(child.id))[0]?.quantity).toBe(2);
    });

    test("the JSON API requires a date when booking a daily parent", async () => {
      await enablePublicApi();
      const { parent, child } = await makeParent({
        children: [{ daily: true }],
        parent: { daily: true },
      });
      const res = await bookParentChild(parent, child);
      expect(res.status).toBe(400);
    });

    test("the JSON API validates merged parent+child contact fields", async () => {
      await enablePublicApi();
      // The child requires a phone the parent doesn't, so a body without one is
      // rejected against the MERGED field set (contact validation after the fold).
      const { parent, child } = await makeParent({
        children: [{ fields: "phone" }],
        parent: { fields: "" },
      });
      const res = await bookParentChild(parent, child);
      expect(res.status).toBe(400);
    });

    test("the JSON API returns 409 when a child sells out before creation", async () => {
      await enablePublicApi();
      // A 1-capacity daily child passes the date-less fold but fails the atomic
      // date-specific capacity check, so the all-or-nothing save reports 409.
      const { parent, child } = await makeParent({
        children: [{ daily: true, maxAttendees: 1 }],
        parent: { daily: true },
      });
      // Fill the child's only spot on that date.
      const date = (await bookableStartDates(parent.id))[0]!;
      await bookAttendee(child, { date, quantity: 1 });
      const res = await bookParentChild(parent, child, { date });
      expect(res.status).toBe(409);
    });

    test("the JSON API still books an ordinary listing", async () => {
      await enablePublicApi();
      const listing = await createTestListing({ name: "Plain" });
      const res = await apiBook(listing.slug);
      expect(res.status).toBe(200);
      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    });
  },
);
