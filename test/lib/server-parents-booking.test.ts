import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import type { Listing } from "#shared/types.ts";
import {
  apiBook,
  apiGet,
  apiListingSlugs,
  createDailyTestListing,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  makeParent,
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
  },
);
