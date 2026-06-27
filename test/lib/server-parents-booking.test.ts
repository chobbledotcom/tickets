import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import type { Listing } from "#shared/types.ts";
import {
  apiBook,
  apiGet,
  apiListingSlugs,
  createDailyTestListing,
  createTestAttendee,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectReserved,
  makeParent,
  postBooking,
  ticketGet,
} from "#test-utils";

describeWithEnv(
  "server > parents booking gate",
  { db: true, triggers: true },
  () => {
    test("a child slug cannot start a booking (404)", async () => {
      const { child } = await makeParent();
      const res = await ticketGet(child.slug);
      expect(res.status).toBe(404);
    });

    test("a parent slug still renders its booking page", async () => {
      const { parent } = await makeParent();
      const res = await ticketGet(parent.slug);
      expect(res.status).toBe(200);
    });

    test("a child mixed into a multi-slug URL rejects the whole request", async () => {
      const { child } = await makeParent();
      const other = await createTestListing({ name: "Unrelated" });
      const res = await ticketGet(`${child.slug}+${other.slug}`);
      expect(res.status).toBe(404);
    });

    test("an ordinary (non-child) listing is unaffected", async () => {
      const listing = await createTestListing({ name: "Plain" });
      const res = await ticketGet(listing.slug);
      expect(res.status).toBe(200);
    });

    // Table-driven: the parent-quantity clamp / group-cap render cluster. Each
    // row builds a scenario, renders the parent's booking page, isolates the
    // `quantity_<parent.id>` <select>, and asserts which quantity options it
    // offers (`contains`) and rejects (`notContains`). The setup varies — some
    // rows pre-create a separate child-only group — so each row supplies its own
    // async `setup`; the comment on each documents the invariant it protects.
    const QUANTITY_CLAMP_CASES: {
      name: string;
      setup: () => Promise<{ parent: Listing }>;
      contains: string;
      notContains: string[];
    }[] = [
      {
        contains: '"1"',
        // The parent offers up to 5, but its single auto-selected child is capped
        // at 1, so child quantity (slaved to the parent) can only be 1 — the page
        // must offer only quantity 0–1, not 2–5 the submit fold would reject
        // (Codex 565).
        name: "a parent's quantity is clamped to a single child's capacity",
        notContains: ['"2"', '"5"'],
        setup: () =>
          makeParent({
            children: [{ maxAttendees: 50, maxQuantity: 1 }],
            parent: { maxAttendees: 50, maxQuantity: 5 },
          }),
      },
      {
        contains: '"3"',
        // With the child capped at 3, the parent offering 5 must offer up to 3 and
        // no higher (Codex 565).
        name: "a parent's quantity is clamped to a child capped at three",
        notContains: ['"4"', '"5"'],
        setup: () =>
          makeParent({
            children: [{ maxAttendees: 50, maxQuantity: 3 }],
            parent: { maxAttendees: 50, maxQuantity: 5 },
          }),
      },
      {
        contains: '"1"',
        // Parent and its only child share a capped group, so each order consumes
        // TWO group spots (parent + auto-selected child). With two spots free the
        // selector must offer quantity 1 and never 2, which the submit-side
        // combined-demand check would reject (Fix 3, invariant I7).
        name: "a parent + child sharing a capped group with 2 spots offers only qty 1",
        notContains: ['"2"'],
        setup: () =>
          makeParent({
            children: [{ maxQuantity: 5 }],
            group: { maxAttendees: 2, name: "Pool" },
            parent: { maxQuantity: 5 },
          }),
      },
      {
        contains: '"2"',
        // With four shared spots free, two parent+child orders fit (four units), so
        // the selector offers up to quantity 2 and no higher (Fix 3).
        name: "a parent + child sharing a capped group with 4 spots offers up to qty 2",
        notContains: ['"3"'],
        setup: () =>
          makeParent({
            children: [{ maxQuantity: 5 }],
            group: { maxAttendees: 4, name: "Pool" },
            parent: { maxQuantity: 5 },
          }),
      },
      {
        contains: '"1"',
        // The parent is ungrouped, but its two children share ONE capped child-only
        // group with a single spot. Under per-unit selection 1-of-each consumes TWO
        // spots from that one pool, so only one combined order fits. The parent
        // quantity selector must offer 1 and never 2 — summing each child's own cap
        // (1 + 1 = 2) over-offered, and `checkBatchAvailability` would reject a 2.
        name: "an ungrouped parent + two children sharing a 1-spot capped group offers parent max 1 (Fix 3)",
        notContains: ['"2"'],
        setup: async () => {
          const childGroup = await createTestGroup({
            maxAttendees: 1,
            name: "Add-on pool",
          });
          return makeParent({
            children: [
              { groupId: childGroup.id, maxAttendees: 50, maxQuantity: 5 },
              { groupId: childGroup.id, maxAttendees: 50, maxQuantity: 5 },
            ],
            parent: { maxAttendees: 50, maxQuantity: 5 },
          });
        },
      },
      {
        contains: '"3"',
        // The same child-only capped group with three spots fits three child units
        // total across the two children, so the parent offers up to 3 and no higher
        // — proving the cohort is clamped by the pool's remaining (3), not summed
        // per child (5 + 5) and not floor-divided (this group has no parent in it).
        name: "an ungrouped parent + two children sharing a 3-spot capped group offers parent max 3 (Fix 3)",
        notContains: ['"4"'],
        setup: async () => {
          const childGroup = await createTestGroup({
            maxAttendees: 3,
            name: "Add-on pool",
          });
          return makeParent({
            children: [
              { groupId: childGroup.id, maxAttendees: 50, maxQuantity: 5 },
              { groupId: childGroup.id, maxAttendees: 50, maxQuantity: 5 },
            ],
            parent: { maxAttendees: 50, maxQuantity: 9 },
          });
        },
      },
      {
        contains: '"1"',
        // The shared group has 10 spots — `floor(10 / 2) = 5` parent+child orders
        // would fit the pool — but the single child itself caps at 1, so only ONE
        // order can actually be fulfilled. The parent quantity (which the sole child
        // is auto-filled to) must be clamped to 1, never offering 2 the submit fold
        // would reject. Before Fix 5 the shared-group cap ignored the child's own
        // `maxPurchasable` and offered up to 5.
        name: "a parent + child sharing a big capped group is clamped by the child's own capacity (Fix 5)",
        notContains: ['"2"'],
        setup: () =>
          makeParent({
            children: [{ maxAttendees: 50, maxQuantity: 1 }],
            group: { maxAttendees: 10, name: "Pool" },
            parent: { maxAttendees: 50, maxQuantity: 5 },
          }),
      },
    ];
    for (const c of QUANTITY_CLAMP_CASES) {
      test(c.name, async () => {
        const { parent } = await c.setup();
        const body = await (await ticketGet(parent.slug)).text();
        const select = body.slice(body.indexOf(`name="quantity_${parent.id}"`));
        const options = select.slice(0, select.indexOf("</select>"));
        expect(options).toContain(`value=${c.contains}`);
        for (const value of c.notContains) {
          expect(options).not.toContain(`value=${value}`);
        }
      });
    }

    test("a shared-group child's per-unit select is clamped by its own capacity (Fix 5)", async () => {
      // With a second (separate-pool) child the shared child renders a per-unit
      // select. The shared group has 10 spots (floor(10/2)=5 orders), but the
      // shared child caps at 1, so its OWN select must offer max 1 — the separate
      // sibling absorbs the rest of the parent's quantity.
      const group = await createTestGroup({ maxAttendees: 10, name: "Pool" });
      const { parent, children } = await makeParent({
        children: [
          { groupId: group.id, maxAttendees: 50, maxQuantity: 1 },
          { maxAttendees: 50, maxQuantity: 3 },
        ],
        parent: { groupId: group.id, maxAttendees: 50, maxQuantity: 3 },
      });
      const shared = children[0]!;
      const body = await (await ticketGet(parent.slug)).text();
      const start = body.indexOf(`name="child_qty_${parent.id}_${shared.id}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const select = body.slice(start);
      const options = select.slice(0, select.indexOf("</select>"));
      expect(options).toContain('value="1"');
      expect(options).not.toContain('value="2"');
    });

    test("a group containing a child member still renders (not 404)", async () => {
      // The group page loads members indirectly, so a child member is suppressed
      // /folded — not a reason to 404 the whole group (the buyer isn't starting
      // from the child directly).
      const { group } = await makeParent({ group: { name: "Combo" } });
      const res = await ticketGet(group!.slug);
      expect(res.status).toBe(200);
    });

    test("a signed QR for a child is rejected", async () => {
      const { child } = await makeParent();
      const { handleRequest } = await import("#routes");
      const token = await signQrBookToken(
        child.slug,
        buildQrBookPayload({ name: "Ada" }),
      );
      const res = await handleRequest(
        new Request(
          `http://localhost/ticket/${child.slug}/qr-book?t=${encodeURIComponent(
            token,
          )}`,
          { headers: { host: "localhost" } },
        ),
      );
      expect(res.status).toBe(404);
    });

    test("the JSON API rejects booking a child slug", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { child } = await makeParent();
      const res = await apiBook(child.slug);
      expect(res.status).toBe(400);
    });

    test("the JSON API books a free parent with its sole child auto-filled", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { parent, child } = await makeParent();
      // No `children` array: the sole bookable child is auto-filled.
      const res = await apiBook(parent.slug);
      expect(res.status).toBe(200);
      const { ticketToken } = (
        (await res.json()) as {
          booking: { ticketToken: string };
        }
      ).booking;
      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
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
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
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
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
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
        const { settings } = await import("#shared/db/settings.ts");
        await settings.update.showPublicApi(true);
        const { parent, child } = await makeParent(c.makeParentArgs);
        const res = await apiBook(parent.slug, await c.body(child));
        expect(res.status).toBe(400);
        if (c.expectErrorContains !== undefined) {
          const body = (await res.json()) as { error: string };
          expect(body.error).toContain(c.expectErrorContains);
        }
        if (c.expectZeroParentAttendees) {
          const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
          expect((await getAttendeesRaw(parent.id)).length).toBe(0);
        }
      });
    }

    test("the JSON API sums repeated child slugs to the parent quantity", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
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
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      expect((await getAttendeesRaw(child.id))[0]?.quantity).toBe(2);
    });

    test("the JSON API requires a date when booking a daily parent", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { parent, child } = await makeParent({
        children: [{ daily: true }],
        parent: { daily: true },
      });
      const res = await apiBook(parent.slug, {
        children: [{ quantity: 1, slug: child.slug }],
      });
      expect(res.status).toBe(400);
    });

    test("the JSON API validates merged parent+child contact fields", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // The child requires a phone the parent doesn't, so a body without one is
      // rejected against the MERGED field set (contact validation after the fold).
      const { parent, child } = await makeParent({
        children: [{ fields: "phone" }],
        parent: { fields: "" },
      });
      const res = await apiBook(parent.slug, {
        children: [{ quantity: 1, slug: child.slug }],
      });
      expect(res.status).toBe(400);
    });

    test("the JSON API returns 409 when a child sells out before creation", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { bookAttendee } = await import("#test-utils");
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      // A 1-capacity daily child passes the date-less fold but fails the atomic
      // date-specific capacity check, so the all-or-nothing save reports 409.
      const { parent, child } = await makeParent({
        children: [{ daily: true, maxAttendees: 1 }],
        parent: { daily: true },
      });
      const parentRow = (await getListingWithCount(parent.id))!;
      const date = getBookableStartDates(
        parentRow,
        await getActiveHolidays(),
      )[0]!;
      // Fill the child's only spot on that date.
      await bookAttendee(child, { date, quantity: 1 });
      const res = await apiBook(parent.slug, {
        children: [{ quantity: 1, slug: child.slug }],
        date,
      });
      expect(res.status).toBe(409);
    });

    test("the JSON API still books an ordinary listing", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const listing = await createTestListing({ name: "Plain" });
      const res = await apiBook(listing.slug);
      expect(res.status).toBe(200);
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    });

    test("a paid API parent booking with a parent customPrice charges that price (Fix 4)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // The PARENT is pay-more; the request's `customPrice` must be parsed and
      // folded onto the parent line, so the checkout item is charged at the
      // chosen £30, not its £10 unit price (which would undercharge).
      const { setupStripe } = await import("#test-utils");
      const { stub } = await import("@std/testing/mock");
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      await setupStripe();

      const { parent } = await makeParent({
        children: [{ maxAttendees: 50, unitPrice: 0 }],
        parent: {
          canPayMore: true,
          maxAttendees: 50,
          maxPrice: 5000,
          unitPrice: 1000,
        },
      });

      let capturedIntent:
        | import("#shared/payments.ts").CheckoutIntent
        | undefined;
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        (intent: import("#shared/payments.ts").CheckoutIntent) => {
          capturedIntent = intent;
          return Promise.resolve({
            checkoutUrl: "https://stripe.test/checkout",
            sessionId: "cs_parent_custom_price",
          });
        },
      );

      try {
        const res = await apiBook(parent.slug, { customPrice: "30.00" });
        expect(res.status).toBe(200);
        const parentItem = capturedIntent?.items.find(
          (i) => i.listingId === parent.id,
        );
        expect(parentItem?.unitPrice).toBe(3000);
      } finally {
        mockCreate.restore();
      }
    });

    test("an API parent booking rejects an out-of-range parent customPrice (Fix 4)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // The pay-more parent's submitted price exceeds its max_price, so the
      // parent custom-price parse fails and the booking is rejected with a 400 —
      // never silently falling back to the unit price.
      const { parent } = await makeParent({
        children: [{ maxAttendees: 50, unitPrice: 0 }],
        parent: {
          canPayMore: true,
          maxAttendees: 50,
          maxPrice: 5000,
          unitPrice: 1000,
        },
      });
      const res = await apiBook(parent.slug, { customPrice: "100.00" });
      expect(res.status).toBe(400);
    });

    test("a paid API parent booking carries the folded dayCount for a customisable child (Fix 3)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // The parent is a FIXED 3-day daily listing (not customisable, so bookable
      // through the API), and its child is customisable. Folding the child flips
      // the order to customisable, so the intent must carry dayCount=3 and the
      // child must be priced for the inherited 3-day span (£30) — without it the
      // webhook reprices the child at a 1-day span (£10) and refunds the gap.
      const { setupStripe } = await import("#test-utils");
      const { stub } = await import("@std/testing/mock");
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      await setupStripe();

      const { parent, child } = await makeParent({
        children: [
          {
            customisableDays: true,
            dayPrices: { 1: 1000, 3: 3000 },
            durationDays: 3,
            maxPrice: 0,
            unitPrice: 0,
          },
        ],
        parent: { daily: true, durationDays: 3 },
      });

      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const date = getBookableStartDates(
        (await getListingWithCount(parent.id))!,
        await getActiveHolidays(),
      )[0]!;

      let capturedIntent:
        | import("#shared/payments.ts").CheckoutIntent
        | undefined;
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        (intent: import("#shared/payments.ts").CheckoutIntent) => {
          capturedIntent = intent;
          return Promise.resolve({
            checkoutUrl: "https://stripe.test/checkout",
            sessionId: "cs_api_custom_child",
          });
        },
      );

      try {
        const res = await apiBook(parent.slug, {
          children: [{ quantity: 1, slug: child.slug }],
          date,
        });
        expect(res.status).toBe(200);
        expect(capturedIntent?.dayCount).toBe(3);
        const childItem = capturedIntent?.items.find(
          (i) => i.listingId === child.id,
        );
        expect(childItem?.unitPrice).toBe(3000);
      } finally {
        mockCreate.restore();
      }
    });

    test("a paid API parent booking for a sold-out folded order returns 409 (Fix 5)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // The paid path must run the folded checkAvailability preflight before
      // creating the session. A 1-capacity daily child passes the date-LESS fold
      // (a daily child's date-less aggregate is judged per-date downstream) but is
      // full on the chosen date, so the date-aware preflight rejects it: the
      // booking must return 409 instead of handing back a checkout URL.
      const { setupStripe, bookAttendee } = await import("#test-utils");
      const { stub } = await import("@std/testing/mock");
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      await setupStripe();

      const { parent, child } = await makeParent({
        children: [{ daily: true, maxAttendees: 1, unitPrice: 1000 }],
        parent: { daily: true, unitPrice: 1000 },
      });
      const date = getBookableStartDates(
        (await getListingWithCount(parent.id))!,
        await getActiveHolidays(),
      )[0]!;
      // Fill the child's only spot on that date so the folded order is sold out.
      await bookAttendee(child, { date, quantity: 1 });

      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () =>
          Promise.resolve({
            checkoutUrl: "https://stripe.test/checkout",
            sessionId: "cs_should_not_be_reached",
          }),
      );

      try {
        const res = await apiBook(parent.slug, {
          children: [{ quantity: 1, slug: child.slug }],
          date,
        });
        expect(res.status).toBe(409);
        // The preflight rejected before the provider was ever called.
        expect(mockCreate.calls.length).toBe(0);
      } finally {
        mockCreate.restore();
      }
    });

    test("GET /api/listings omits a child listing", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { parent, child } = await makeParent();
      const slugs = await apiListingSlugs();
      expect(slugs).toContain(parent.slug);
      expect(slugs).not.toContain(child.slug);
    });

    test("a child listing detail endpoint is not bookable (404)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { child } = await makeParent();
      const res = await apiGet(`/api/listings/${child.slug}`);
      expect(res.status).toBe(404);
    });

    test("a child listing availability endpoint is not bookable (404)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { child } = await makeParent();
      const res = await apiGet(`/api/listings/${child.slug}/availability`);
      expect(res.status).toBe(404);
    });

    test("an ordinary listing API detail is unaffected", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const listing = await createTestListing({ name: "Plain" });
      const res = await apiGet(`/api/listings/${listing.slug}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        listing: { slug: string; maxPurchasable: number };
      };
      expect(body.listing.slug).toBe(listing.slug);
      expect(body.listing.maxPurchasable).toBeGreaterThan(0);
    });

    test("a parent with no bookable child reads sold out in API detail", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // A child with no capacity is its parent's only child, so the parent has
      // no bookable child and is sold out (invariant I6).
      const { parent } = await makeParent({ children: [{ maxAttendees: 0 }] });
      const res = await apiGet(`/api/listings/${parent.slug}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        listing: { isSoldOut: boolean; maxPurchasable: number };
      };
      expect(body.listing.isSoldOut).toBe(true);
      expect(body.listing.maxPurchasable).toBe(0);
    });

    test("a parent with no bookable child reports unavailable in API availability", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { parent } = await makeParent({ children: [{ maxAttendees: 0 }] });
      const res = await apiGet(`/api/listings/${parent.slug}/availability`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean };
      expect(body.available).toBe(false);
    });

    test("a parent with a bookable child stays available in API availability", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { parent } = await makeParent();
      const res = await apiGet(`/api/listings/${parent.slug}/availability`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean };
      expect(body.available).toBe(true);
    });

    test("API detail of a parent lists its required children with prices", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { parent, child } = await makeParent({
        children: [{ unitPrice: 1500 }],
      });
      const res = await apiGet(`/api/listings/${parent.slug}`);
      const body = (await res.json()) as {
        listing: { children?: { slug: string; unitPrice: number }[] };
      };
      expect(body.listing.children).toEqual([
        expect.objectContaining({ slug: child.slug, unitPrice: 1500 }),
      ]);
    });

    test("API detail of an ordinary listing has no children field", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const listing = await createTestListing({ name: "Plain" });
      const res = await apiGet(`/api/listings/${listing.slug}`);
      const body = (await res.json()) as { listing: { children?: unknown } };
      expect(body.listing.children).toBeUndefined();
    });

    test("API detail omits an inactive child from a parent's children (Fix 2)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // An inactive child with spare capacity would, unfiltered, read
      // isClosed:false with a positive maxPurchasable while the booking fold
      // rejects it (childActive) — so the detail endpoint must not advertise it,
      // matching the availability endpoint that already reports it unavailable.
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const okChild = children[0]!;
      const inactiveChild = children[1]!;
      const { execute } = await import("#shared/db/client.ts");
      await execute("UPDATE listings SET active = 0 WHERE id = ?", [
        inactiveChild.id,
      ]);
      const res = await apiGet(`/api/listings/${parent.slug}`);
      const body = (await res.json()) as {
        listing: { children?: { slug: string }[] };
      };
      const slugs = (body.listing.children ?? []).map((c) => c.slug);
      expect(slugs).toEqual([okChild.slug]);
    });

    test("API availability of a parent reports per-child availability", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { parent, children } = await makeParent({
        children: [{}, { maxAttendees: 0 }],
      });
      const okChild = children[0]!;
      const fullChild = children[1]!;
      const res = await apiGet(`/api/listings/${parent.slug}/availability`);
      const body = (await res.json()) as {
        children?: { slug: string; available: boolean }[];
      };
      expect(body.children).toEqual(
        expect.arrayContaining([
          { available: true, slug: okChild.slug },
          { available: false, slug: fullChild.slug },
        ]),
      );
    });

    test("API availability reports an inactive child unavailable (Fix 1)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // A second active child keeps the parent itself bookable, so the response
      // carries the per-child availability array. The inactive child has spare
      // capacity but the booking fold rejects it (childActive), so it must report
      // `available: false` rather than advertising spots the booking POST refuses.
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const okChild = children[0]!;
      const inactiveChild = children[1]!;
      const { execute } = await import("#shared/db/client.ts");
      await execute("UPDATE listings SET active = 0 WHERE id = ?", [
        inactiveChild.id,
      ]);
      const res = await apiGet(`/api/listings/${parent.slug}/availability`);
      const body = (await res.json()) as {
        children?: { slug: string; available: boolean }[];
      };
      expect(body.children).toEqual(
        expect.arrayContaining([
          { available: true, slug: okChild.slug },
          { available: false, slug: inactiveChild.slug },
        ]),
      );
    });

    test("API availability reports a registration-closed child unavailable (Fix 1)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // The second child's registration has closed (closes_at in the past); like
      // the inactive case it has spare capacity but the fold rejects it
      // (childOpen), so it must report `available: false`.
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const okChild = children[0]!;
      const closedChild = children[1]!;
      const { execute } = await import("#shared/db/client.ts");
      const { writeClosesAt } = await import("#shared/db/listings.ts");
      await execute("UPDATE listings SET closes_at = ? WHERE id = ?", [
        await writeClosesAt("2000-01-01T00:00:00.000Z"),
        closedChild.id,
      ]);
      const res = await apiGet(`/api/listings/${parent.slug}/availability`);
      const body = (await res.json()) as {
        children?: { slug: string; available: boolean }[];
      };
      expect(body.children).toEqual(
        expect.arrayContaining([
          { available: true, slug: okChild.slug },
          { available: false, slug: closedChild.slug },
        ]),
      );
    });

    test("API availability of a daily parent with no date reports per-child availability", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // No `date` query param: a daily child's availability is checked date-less
      // (its own cumulative capacity), so a client still sees which children
      // exist before choosing a date.
      const { parent, child } = await makeParent({
        children: [{ daily: true }],
        parent: { daily: true },
      });
      const res = await apiGet(`/api/listings/${parent.slug}/availability`);
      const body = (await res.json()) as {
        children?: { slug: string; available: boolean }[];
      };
      expect(body.children).toEqual([{ available: true, slug: child.slug }]);
    });

    test("a daily parent's availability is false for a date no child can serve (Fix 1)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // The parent is bookable every weekday, but its only (daily) child is
      // bookable only on Mondays. A date the child cannot serve must report
      // `available: false` even though the parent's OWN row has capacity — the
      // availability endpoint must honour the child-date union, matching the
      // detail endpoint and the booking fold (Fix 1).
      const { parent, child } = await makeParent({
        children: [{ bookableDays: ["Monday"], daily: true }],
        parent: { daily: true },
      });

      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const holidays = await getActiveHolidays();
      const parentDates = getBookableStartDates(
        (await getListingWithCount(parent.id))!,
        holidays,
      );
      const childDates = new Set(
        getBookableStartDates((await getListingWithCount(child.id))!, holidays),
      );
      const servable = parentDates.find((d) => childDates.has(d))!;
      const unservable = parentDates.find((d) => !childDates.has(d))!;

      const blocked = (await (
        await apiGet(
          `/api/listings/${parent.slug}/availability?date=${unservable}`,
        )
      ).json()) as { available: boolean };
      expect(blocked.available).toBe(false);

      const open = (await (
        await apiGet(
          `/api/listings/${parent.slug}/availability?date=${servable}`,
        )
      ).json()) as { available: boolean };
      expect(open.available).toBe(true);
    });

    test("API availability reports a daily child unavailable when it can't serve the date (Fix B)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // Parent has two daily children: A serves all days, B serves only Monday.
      // When the buyer picks a non-Monday date, childA is available but childB
      // is not — even though the parent-level constrainParentDailyDates check
      // passes (childA covers the date). Fix B ensures buildChildAvailability
      // checks each child's own calendar, not just capacity.
      const { parent, children } = await makeParent({
        children: [{ daily: true }, { bookableDays: ["Monday"], daily: true }],
        parent: { daily: true },
      });
      const [childA, childB] = children;

      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const holidays = await getActiveHolidays();
      const parentDates = getBookableStartDates(
        (await getListingWithCount(parent.id))!,
        holidays,
      );
      const childBDates = new Set(
        getBookableStartDates(
          (await getListingWithCount(childB!.id))!,
          holidays,
        ),
      );
      // A date the parent and childA serve but childB does not (non-Monday).
      const nonMondayDate = parentDates.find((d) => !childBDates.has(d))!;

      const res = await apiGet(
        `/api/listings/${parent.slug}/availability?date=${nonMondayDate}`,
      );
      const body = (await res.json()) as {
        available: boolean;
        children?: { slug: string; available: boolean }[];
      };
      // Parent is available (childA covers the date).
      expect(body.available).toBe(true);
      // ChildA reports available; childB does not.
      expect(body.children).toEqual(
        expect.arrayContaining([
          { available: true, slug: childA!.slug },
          { available: false, slug: childB!.slug },
        ]),
      );
    });

    test("a group page renders the parent with a child selector but no standalone child quantity row", async () => {
      const { parent, child, group } = await makeParent({
        group: { name: "Combo" },
      });
      const body = await (await ticketGet(group!.slug)).text();
      // The parent still offers its standalone quantity selector and the child
      // appears in the parent's child block (here a sole child, auto-selected and
      // shown informationally); the child must NOT get its own standalone
      // quantity control (`quantity_<childId>`).
      expect(body).toContain(`name="quantity_${parent.id}"`);
      expect(body).toContain(`data-sole-child="${child.id}"`);
      expect(body).not.toContain(`name="quantity_${child.id}"`);
    });

    test("a group page cannot book the child alone", async () => {
      const { child, group } = await makeParent({ group: { name: "Combo" } });
      const { handleRequest } = await import("#routes");
      const { signCsrfToken } = await import("#shared/csrf.ts");
      const res = await handleRequest(
        new Request(`http://localhost/ticket/${group!.slug}`, {
          body: new URLSearchParams({
            csrf_token: await signCsrfToken(),
            email: "a@b.com",
            name: "Ada",
            [`quantity_${child.id}`]: "1",
          }),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "localhost",
          },
          method: "POST",
        }),
      );
      // The child's quantity field is ignored (it is not a standalone row), so
      // no child attendee is created.
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      expect((await getAttendeesRaw(child.id)).length).toBe(0);
      expect(res.status).not.toBe(500);
    });

    test("a group of ordinary listings is unaffected", async () => {
      const group = await createTestGroup({ name: "Plain combo" });
      const a = await createTestListing({ groupId: group.id, name: "A" });
      const b = await createTestListing({ groupId: group.id, name: "B" });
      const body = await (await ticketGet(group.slug)).text();
      expect(body).toContain(`name="quantity_${a.id}"`);
      expect(body).toContain(`name="quantity_${b.id}"`);
    });

    test("GET /api/listings reports a no-bookable-child parent as sold out (Fix 3)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // The parent's only child has no capacity, so the parent has no bookable
      // child and is sold out (invariant I6) — the list response must project
      // that, matching the detail/availability endpoints (Fix 3), not advertise
      // the parent's own standalone capacity as bookable.
      const { parent } = await makeParent({ children: [{ maxAttendees: 0 }] });
      const body = (await (await apiGet("/api/listings")).json()) as {
        listings: {
          slug: string;
          isSoldOut: boolean;
          maxPurchasable: number;
        }[];
      };
      const row = body.listings.find((l) => l.slug === parent.slug)!;
      expect(row.isSoldOut).toBe(true);
      expect(row.maxPurchasable).toBe(0);
    });

    test("GET /api/listings keeps a parent with a bookable child bookable (Fix 3)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const { parent } = await makeParent();
      const body = (await (await apiGet("/api/listings")).json()) as {
        listings: {
          slug: string;
          isSoldOut: boolean;
          maxPurchasable: number;
        }[];
      };
      const row = body.listings.find((l) => l.slug === parent.slug)!;
      expect(row.isSoldOut).toBe(false);
      expect(row.maxPurchasable).toBeGreaterThan(0);
    });

    test("API detail availableDates of a daily parent equal the child-constrained intersection (Fix 4)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      // The parent is bookable every weekday, but its only (daily) child is
      // bookable only on Mondays. The API detail must advertise only the dates a
      // child can serve — the intersection — so it never offers a date the web
      // selector removes and the fold rejects (Fix 4).
      const { parent, child } = await makeParent({
        children: [{ bookableDays: ["Monday"], daily: true }],
        parent: { daily: true },
      });

      const { getAvailableDates, getBookableStartDates } = await import(
        "#shared/dates.ts"
      );
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const holidays = await getActiveHolidays();
      const parentRow = (await getListingWithCount(parent.id))!;
      const childRow = (await getListingWithCount(child.id))!;
      const parentDates = getAvailableDates(parentRow, holidays);
      const childDates = new Set(getBookableStartDates(childRow, holidays));
      const expected = parentDates.filter((d) => childDates.has(d));

      const res = await apiGet(`/api/listings/${parent.slug}`);
      const body = (await res.json()) as {
        listing: { availableDates: string[] };
      };
      expect(body.listing.availableDates).toEqual(expected);
      // The constraint actually removed dates (the parent's own calendar is wider
      // than the intersection) — otherwise the assertion would pass vacuously.
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(parentDates.length);
    });

    test("a plain daily listing API detail keeps its full calendar (Fix 4 no-op)", async () => {
      // A daily listing with no child edges is not a parent, so the child-date
      // constraint is a no-op: the API still advertises its own full calendar.
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const listing = await createDailyTestListing({ name: "Plain daily" });
      const { getAvailableDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const expected = getAvailableDates(
        (await getListingWithCount(listing.id))!,
        await getActiveHolidays(),
      );
      const res = await apiGet(`/api/listings/${listing.slug}`);
      const body = (await res.json()) as {
        listing: { availableDates: string[] };
      };
      expect(body.listing.availableDates).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
    });

    test("a group whose only member is a child returns 404 (Fix 6)", async () => {
      // Every member of the group is a child of a parent outside the group, so
      // dropping children empties the page — there is nothing standalone-bookable
      // and a booking can never start from a child, so the group page 404s rather
      // than rendering a 200 empty booking page (Fix 6).
      const group = await createTestGroup({ name: "Child-only group" });
      await makeParent({ children: [{ groupId: group.id }] });
      const res = await ticketGet(group.slug);
      res.body?.cancel();
      expect(res.status).toBe(404);
    });

    test("a group with a child-only set suppresses its CTA on /listings (Fix 6)", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicSite(true);
      const group = await createTestGroup({ name: "Child-only listed group" });
      await makeParent({ children: [{ groupId: group.id }] });
      // The group page itself 404s (asserted above); the /listings CTA pointing
      // at it must be suppressed so it never advertises a dead link.
      const { handleRequest } = await import("#routes");
      const listings = await handleRequest(
        new Request("http://localhost/listings", {
          headers: { host: "localhost" },
        }),
      );
      const listingsBody = await listings.text();
      expect(listingsBody).not.toContain(`href="/ticket/${group.slug}"`);
    });

    test("a group whose only non-child member is a no-bookable-child parent suppresses its /listings CTA", async () => {
      // The group's only member is a PARENT (not a child) whose required child
      // is sold out, so the group page projects that parent sold out and offers
      // no bookable quantity. The /listings Book CTA to /ticket/<group> must be
      // suppressed too — counting the parent as a "bookable member" because it
      // isn't a child would advertise an uncompletable booking.
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicSite(true);
      const group = await createTestGroup({ name: "Sold-out-parent group" });
      const parent = await createTestListing({
        groupId: group.id,
        name: "Base in group",
      });
      const child = await createTestListing({
        maxAttendees: 1,
        name: "Sold-out add-on",
      });
      await createTestAttendee(child.id, child.slug, "Buyer", "b@x.com");
      await setChildIds(parent.id, [child.id]);
      const { handleRequest } = await import("#routes");
      const listings = await handleRequest(
        new Request("http://localhost/listings", {
          headers: { host: "localhost" },
        }),
      );
      const listingsBody = await listings.text();
      expect(listingsBody).not.toContain(`href="/ticket/${group.slug}"`);
    });

    test("a group QR 404s when its only active member is a child (Fix 3)", async () => {
      // The group's only active member is a child of a parent outside the group,
      // so `/ticket/<group>` drops it and 404s — its QR encodes that dead link,
      // so the QR route must 404 too (Fix 3).
      const group = await createTestGroup({ name: "Child-only QR group" });
      await makeParent({ children: [{ groupId: group.id }] });
      const { handleRequest } = await import("#routes");
      const res = await handleRequest(
        new Request(`http://localhost/ticket/${group.slug}/qr`, {
          headers: { host: "localhost" },
        }),
      );
      res.body?.cancel();
      expect(res.status).toBe(404);
    });

    test("an ordinary group's QR still renders (Fix 3)", async () => {
      const group = await createTestGroup({ name: "Plain QR group" });
      await createTestListing({ groupId: group.id, name: "A" });
      await createTestListing({ groupId: group.id, name: "B" });
      const { handleRequest } = await import("#routes");
      const res = await handleRequest(
        new Request(`http://localhost/ticket/${group.slug}/qr`, {
          headers: { host: "localhost" },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      const body = await res.text();
      expect(body).toContain("<svg");
    });

    test(
      "Stage B: free booking of a child under two parents creates" +
        " two rows with distinct parentListingId",
      async () => {
        // The buyer books parentA (qty 1) and parentB (qty 1) in one cart.
        // Both require the same shared child. With Stage B, expandChildAllocations
        // splits the folded child into two listing_attendees rows (one per
        // parent), each carrying the correct parentListingId.
        const child = await createTestListing({
          maxAttendees: 10,
          maxQuantity: 10,
          name: "stage-b-child",
        });
        const parentA = await createTestListing({
          maxAttendees: 10,
          maxQuantity: 10,
          name: "stage-b-parentA",
        });
        await setChildIds(parentA.id, [child.id]);
        const parentB = await createTestListing({
          maxAttendees: 10,
          maxQuantity: 10,
          name: "stage-b-parentB",
        });
        await setChildIds(parentB.id, [child.id]);

        const slugs = `${parentA.slug}+${parentB.slug}`;
        const res = await postBooking(slugs, {
          email: "stageB@example.com",
          name: "Stage B",
          [`quantity_${parentA.id}`]: "1",
          [`quantity_${parentB.id}`]: "1",
          [`child_qty_${parentA.id}_${child.id}`]: "1",
          [`child_qty_${parentB.id}_${child.id}`]: "1",
        });
        expectReserved(res);

        // Extract the ticket token from the redirect location.
        const location = res.headers.get("location")!;
        const rawToken = location.split("tokens=")[1]!;
        const ticketToken = decodeURIComponent(rawToken);
        const { getAttendeesByTokens } = await import(
          "#shared/db/attendees.ts"
        );
        const [attendee] = await getAttendeesByTokens([ticketToken]);
        const bookings = attendee!.bookings;

        // The attendee has 4 rows: parentA, parentB, child-under-A,
        // child-under-B.
        expect(bookings.length).toBe(4);
        const childBookings = bookings.filter((b) => b.listing_id === child.id);
        expect(childBookings.length).toBe(2);
        // Each child row links to a distinct parent.
        const parentIds = childBookings.map((b) => b.parent_listing_id);
        expect(parentIds).toContain(parentA.id);
        expect(parentIds).toContain(parentB.id);
        // Each child allocation has qty 1.
        expect(childBookings.every((b) => b.quantity === 1)).toBe(true);
        // All 4 rows share one order_token.
        const token = bookings[0]!.order_token;
        expect(token).toBeTruthy();
        expect(bookings.every((b) => b.order_token === token)).toBe(true);
      },
    );
  },
);
