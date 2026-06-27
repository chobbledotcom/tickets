/**
 * Discovery/share-surface suppression for the listing parent/child feature
 * (parents.md, the "Other entry points" + "no bookable child ⇒ sold out"
 * sections). A *visible* child must never advertise a standalone `/ticket/<slug>`
 * entry point, and a parent with no bookable child must read as sold out, on
 * every discovery surface: public cards, RSS/ICS feeds, the /order gallery, the
 * admin multi-booking link builder, and the per-listing share/QR generators.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { settings } from "#shared/db/settings.ts";
import {
  adminGet,
  createTestAttendee,
  createTestGroup,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  makeParent,
  mockRequest,
} from "#test-utils";

/** Fetch a public page body with the public site enabled. */
const publicBody = async (path: string): Promise<string> => {
  await settings.update.showPublicSite(true);
  const response = await handleRequest(mockRequest(path));
  return response.text();
};

/** Fetch the gallery body with the public site + order page enabled. */
const galleryBody = async (): Promise<string> => {
  await settings.update.showPublicSite(true);
  await settings.update.orderEnabled(true);
  const response = await handleRequest(mockRequest("/order"));
  return response.text();
};

/** Redirect Location for an /order selection. */
const orderRedirect = async (ids: number[]): Promise<string> => {
  await settings.update.showPublicSite(true);
  await settings.update.orderEnabled(true);
  const query = ids.map((id) => `select_${id}=1`).join("&");
  const response = await handleRequest(mockRequest(`/order?${query}`));
  response.body?.cancel();
  return response.headers.get("location") ?? "";
};

/** A sold-out child (maxAttendees 1, one attendee) under a single parent. */
const setupSoldOutChild = async () => {
  const parent = await createTestListing({ name: "Base unit" });
  const child = await createTestListing({ maxAttendees: 1, name: "Add-on" });
  await createTestAttendee(child.id, child.slug, "Buyer", "b@x.com");
  await setChildIds(parent.id, [child.id]);
  return { child, parent };
};

/** A 3-day fixed parent with a customisable daily child.
 * Pass `bookableDays` to restrict the child (e.g. Monday-only). */
const makeThreeDayParent = (bookableDays?: string[]) =>
  makeParent({
    children: [
      {
        ...(bookableDays && { bookableDays }),
        customisableDays: true,
        daily: true,
        dayPrices: { 1: 1000, 3: 3000 },
        durationDays: 3,
        name: "Span add-on",
      },
    ],
    parent: {
      customisableDays: false,
      daily: true,
      durationDays: 3,
      name: "3-day base",
    },
  });

/** A 2-spot capped group (parent + child share it) with one spot already
 * consumed by a filler member. Returns the group, parent, and filler. */
const setupOneSpotPool = async () => {
  const { group, parent } = await makeParent({
    children: [{ name: "Add-on" }],
    group: { maxAttendees: 2, name: "Pool" },
    parent: { name: "Base unit" },
  });
  const filler = await createTestListing({
    groupId: group!.id,
    name: "Filler",
  });
  await createTestAttendee(filler.id, filler.slug, "Buyer", "b@x.com");
  return { group, parent };
};

/** A 2-spot capped group (parent + child share it) with no spots consumed. */
const makeTwoSpotPool = () =>
  makeParent({
    children: [{ name: "Add-on" }],
    group: { maxAttendees: 2, name: "Pool" },
    parent: { name: "Base unit" },
  });

/** Default parent + child pair for tests that don't need specific names. */
const makeDefaultParentChild = () =>
  makeParent({
    children: [{ name: "Add-on" }],
    parent: { name: "Base unit" },
  });

/** Assert the parent's Book link is absent and Sold Out is shown. */
const assertSoldOut = async (parentSlug: string) => {
  const body = await publicBody("/listings");
  expect(body).not.toContain(`href="/ticket/${parentSlug}"`);
  expect(body).toContain("Sold Out");
};

/** Assert the parent's Book link is present. */
const assertBookable = async (parentSlug: string) => {
  const body = await publicBody("/listings");
  expect(body).toContain(`href="/ticket/${parentSlug}"`);
};

/** Assert the add-on note is shown and the child has no standalone link. */
const assertAddOnNote = async (childSlug: string) => {
  const body = await publicBody("/listings");
  expect(body).toContain("Available as an add-on to another booking");
  expect(body).not.toContain(`href="/ticket/${childSlug}"`);
};

describeWithEnv(
  "server > parents discovery suppression",
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

      test("a parent whose only child is sold out renders sold out", async () => {
        const { parent } = await setupSoldOutChild();
        await assertSoldOut(parent.slug);
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
      // or add-on note (Fix 1, parentBookable). Each row disables the only parent
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
        // advertised-as-unavailable child must not be standalone-bookable (Fix 1).
        const { parent, child } = await makeDefaultParentChild();
        await deactivateTestListing(parent.id);
        await settings.update.showPublicSite(true);
        const response = await handleRequest(
          mockRequest(`/ticket/${child.slug}`),
        );
        response.body?.cancel();
        expect(response.status).toBe(404);
      });

      test("a child with a bookable parent shows the add-on note", async () => {
        // The parent is active, not sold out, and not closed, so it can fold the
        // child into a booking — the child's card shows the add-on note and the
        // child's own standalone CTA stays suppressed (Fix 1, parentBookable
        // bookable case).
        const { child } = await makeDefaultParentChild();
        await assertAddOnNote(child.slug);
      });

      test("a child with one active and one inactive parent stays labeled add-on", async () => {
        // At least one active parent can still offer the child, so the standalone
        // CTA must stay suppressed (Fix 1).
        const activeParent = await createTestListing({ name: "Active base" });
        const deadParent = await createTestListing({ name: "Dead base" });
        const child = await createTestListing({ name: "Add-on" });
        await setChildIds(activeParent.id, [child.id]);
        await setChildIds(deadParent.id, [child.id]);
        await deactivateTestListing(deadParent.id);
        await assertAddOnNote(child.slug);
      });

      test("a sold-out visible child shows sold out, not the add-on note", async () => {
        // The unavailable state must take precedence over the add-on note so the
        // card does not advertise an add-on the gate would reject (Fix 2).
        const { parent, child } = await setupSoldOutChild();
        const body = await publicBody("/listings");
        expect(body).toContain("Add-on");
        expect(body).toContain("Sold Out");
        expect(body).not.toContain("Available as an add-on to another booking");
      });

      test("a parent + child sharing a capped group with 1 spot is sold out", async () => {
        // Parent and its only child share a capped group, so the minimum order
        // (one parent + one auto-selected child) consumes TWO group spots. With
        // one spot left, the parent reads sold out even though the child looks
        // individually bookable (Fix 4, combined demand).
        const { parent } = await setupOneSpotPool();
        await assertSoldOut(parent.slug);
      });

      test("a parent + child sharing a capped group with 2 spots is bookable", async () => {
        // With two spots free, the combined parent+child demand fits, so the
        // parent keeps its Book link (Fix 4).
        const { parent } = await makeTwoSpotPool();
        await assertBookable(parent.slug);
      });

      test("a daily parent + daily child sharing a 1-cap group is sold out date-less (static cap)", async () => {
        // A daily child's per-date group-remaining is unknown without a
        // submitted date, so the dynamic combined-demand check cannot see the
        // shortage. But a group whose STATIC cap is below the parent+child
        // minimum (two spots) can NEVER hold the pair on any date, so discovery
        // must read the parent sold out from the static cap alone — otherwise it
        // advertises a booking the submit fold always rejects.
        const { parent } = await makeParent({
          children: [{ daily: true, name: "Daily add-on" }],
          group: { maxAttendees: 1, name: "Tiny pool" },
          parent: { daily: true, name: "Base unit" },
        });
        await assertSoldOut(parent.slug);
      });

      test("a daily parent + daily child sharing a 2-cap group stays bookable date-less", async () => {
        // Static cap 2 meets the parent+child minimum; a daily child's per-date
        // remaining is deferred to the submit fold — so discovery keeps the Book
        // link rather than over-suppressing on a group that can hold the pair.
        const { parent } = await makeParent({
          children: [{ daily: true, name: "Daily add-on" }],
          group: { maxAttendees: 2, name: "Pool" },
          parent: { daily: true, name: "Base unit" },
        });
        await assertBookable(parent.slug);
      });

      test("a fixed multi-day daily parent whose only child can't fit the span is sold out", async () => {
        // The parent is a FIXED 3-day daily listing, so its children inherit a
        // 3-day span at the till. Its only child is a customisable daily add-on
        // that can be booked single days but never a 3-consecutive-day run (only
        // Mondays are bookable, so Mon–Wed always hits an unbookable Tue/Wed). A
        // span-blind discovery check (any one-day start exists) would advertise
        // the parent, but the gate's date union span-constrains it to empty and
        // the submit rejects — so it must read sold out (Fix 1).
        const { parent } = await makeThreeDayParent(["Monday"]);
        await assertSoldOut(parent.slug);
      });

      test("a fixed multi-day daily parent whose child can fit the span is advertised", async () => {
        // Same fixed 3-day parent, but the child can be booked any weekday, so a
        // Mon–Wed 3-day run is valid — the parent keeps its Book link (Fix 1).
        const { parent } = await makeThreeDayParent();
        await assertBookable(parent.slug);
      });

      test("a daily parent whose only child has disjoint bookable weekdays is sold out (Fix 5)", async () => {
        // Both are single-day daily listings, but the parent is bookable only on
        // Mondays and its only child only on Tuesdays. The child has a bookable
        // start on its own calendar (Tuesday), so a child-calendar-only check
        // would still advertise the parent — yet there is NO date the parent can
        // offer on which the child is bookable, so `getTicketContext`'s date union
        // renders empty and the parent must read sold out (Fix 5).
        const { parent } = await makeParent({
          children: [
            {
              bookableDays: ["Tuesday"],
              daily: true,
              name: "Tuesday add-on",
            },
          ],
          parent: {
            bookableDays: ["Monday"],
            daily: true,
            name: "Monday base",
          },
        });
        await assertSoldOut(parent.slug);
      });

      test("a daily parent whose child shares a bookable weekday stays advertised (Fix 5)", async () => {
        // The child is bookable on a weekday the parent also offers (Monday), so
        // there is an overlapping date the gate can serve — the parent keeps its
        // Book link (the Fix 5 overlap is satisfied, not over-eager).
        const { parent } = await makeParent({
          children: [
            {
              bookableDays: ["Monday", "Tuesday"],
              daily: true,
              name: "Mon/Tue add-on",
            },
          ],
          parent: {
            bookableDays: ["Monday"],
            daily: true,
            name: "Monday base",
          },
        });
        await assertBookable(parent.slug);
      });

      test("a parent + child in different capped groups stays bookable", async () => {
        // When parent and child sit in different capped groups they do not share
        // a pool, so the combined-demand check does not apply and the per-row
        // check stands — the parent keeps its Book link (Fix 4, non-shared case).
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
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).toContain(`href="/ticket/${parent.slug}"`);
      });

      test("a child whose only parent shares a 1-spot capped group is not labeled add-on", async () => {
        // The child's only parent shares a capped group with it, so the minimum
        // parent+child order needs two spots. With one spot left the parent is
        // projected sold out, so the add-on note would be a dead end — the child
        // must read unavailable, NOT "available as an add-on" (Fix 5: addOnChildIds
        // must use the same combined-demand check as the parent sold-out
        // projection).
        await setupOneSpotPool();
        const body = await publicBody("/listings");
        expect(body).toContain("Add-on");
        expect(body).not.toContain("Available as an add-on to another booking");
      });

      test("a child whose only parent shares a 2-spot capped group shows the add-on note", async () => {
        // Two spots free ⇒ the combined parent+child demand fits, so the parent
        // can offer the child and the add-on note appears (Fix 5).
        const { child } = await makeTwoSpotPool();
        await assertAddOnNote(child.slug);
      });
    });

    describe("RSS/ICS feeds", () => {
      test("omits a child and a no-bookable-child parent, keeps a normal one", async () => {
        const { child } = await makeParent({
          children: [{ name: "FeedChild" }],
          parent: { name: "FeedParent" },
        });
        await deactivateTestListing(child.id);
        const plain = await createTestListing({ name: "FeedPlain" });
        await settings.update.showPublicSite(true);
        const rss = await (
          await handleRequest(mockRequest("/feeds/listings.rss"))
        ).text();
        // Child is inactive (not in feed regardless) and the parent has no
        // bookable child, so the parent is omitted; the plain listing remains.
        expect(rss).not.toContain("FeedParent");
        expect(rss).not.toContain("FeedChild");
        expect(rss).toContain("FeedPlain");
        expect(rss).toContain(`/ticket/${plain.slug}`);
      });

      test("omits a visible child item from the feed", async () => {
        const { child } = await makeParent({
          children: [{ name: "VisChild" }],
          parent: { name: "VisParent" },
        });
        await settings.update.showPublicSite(true);
        const ics = await (
          await handleRequest(mockRequest("/feeds/listings.ics"))
        ).text();
        // Parent is bookable (one available child) so it stays; the child's own
        // standalone item is omitted.
        expect(ics).toContain("VisParent");
        expect(ics).not.toContain(`/ticket/${child.slug}`);
      });
    });

    describe("/order gallery", () => {
      test("does not offer a child as a selectable card", async () => {
        const { parent, child } = await makeParent({
          children: [{ name: "GalChild" }],
          parent: { name: "GalParent" },
        });
        const body = await galleryBody();
        expect(body).toContain(`name="select_${parent.id}"`);
        expect(body).not.toContain(`name="select_${child.id}"`);
        expect(body).not.toContain("GalChild");
      });

      test("a selection redirect never contains a child slug", async () => {
        const { parent, child } = await makeParent({
          children: [{ name: "GalChild" }],
          parent: { name: "GalParent" },
        });
        // Even if a child id is injected into the query, it is not selectable.
        const location = await orderRedirect([parent.id, child.id]);
        expect(location).toContain(`/ticket/${parent.slug}`);
        expect(location).not.toContain(child.slug);
      });

      test("a parent with no bookable child is dimmed, not pre-filled", async () => {
        const parent = await createTestListing({ name: "GalSoldParent" });
        const child = await createTestListing({
          maxAttendees: 1,
          name: "GalSoldChild",
        });
        await createTestAttendee(child.id, child.slug, "Buyer", "b@x.com");
        await setChildIds(parent.id, [child.id]);
        const body = await galleryBody();
        // Sold-out parents are rendered as a non-selectable, dimmed card.
        expect(body).not.toContain(`name="select_${parent.id}"`);
        const location = await orderRedirect([parent.id]);
        expect(location).not.toContain(`q_${parent.id}=1`);
      });

      test("a registration-closed listing is carried as a slug but never pre-filled", async () => {
        // A closed selection still appears on the booking page (as a slug) so the
        // buyer sees why it can't be booked, but it must NOT receive a `q_<id>=1`
        // quantity pre-fill — the availability filter requires not-closed AND
        // not-sold-out AND a purchasable spot, never just one of them.
        const pastDate = new Date(Date.now() - 60000)
          .toISOString()
          .slice(0, 16);
        const closed = await createTestListing({
          closesAt: pastDate,
          name: "ClosedListing",
        });
        const location = await orderRedirect([closed.id]);
        expect(location).toContain(`/ticket/${closed.slug}`);
        expect(location).not.toContain(`q_${closed.id}=1`);
      });
    });

    describe("admin multi-booking link builder", () => {
      test("excludes children from the selectable checkboxes", async () => {
        const { parent, child } = await makeParent({
          children: [{ name: "MbChild" }],
          parent: { name: "MbParent" },
        });
        const plain = await createTestListing({ name: "MbPlain" });
        const body = await (await adminGet("/admin/")).text();
        expect(body).toContain(`data-multi-booking-slug="${parent.slug}"`);
        expect(body).toContain(`data-multi-booking-slug="${plain.slug}"`);
        expect(body).not.toContain(`data-multi-booking-slug="${child.slug}"`);
      });
    });

    describe("per-listing share / QR generators", () => {
      test("the child detail page suppresses the share/QR affordances", async () => {
        const { child } = await makeParent({
          children: [{ name: "QrChild" }],
          parent: { name: "QrParent" },
        });
        const body = await (
          await adminGet(`/admin/listing/${child.id}`)
        ).text();
        expect(body).not.toContain(`/admin/listing/${child.id}/qr`);
        expect(body).not.toContain(`/ticket/${child.slug}/qr`);
        expect(body).toContain(
          "it has no standalone booking link, embed, or QR code",
        );
        // The public booking URL and both embed snippets are suppressed too — a
        // child has no standalone entry point to share or embed.
        expect(body).not.toContain(`/ticket/${child.slug}`);
        expect(body).not.toContain(`embed-toggle-${child.id}`);
        expect(body).not.toContain(`embed-script-${child.id}`);
        expect(body).not.toContain(`embed-iframe-${child.id}`);
      });

      test("a parent detail page keeps its share/QR affordances", async () => {
        const { parent } = await makeParent({
          children: [{ name: "QrChild" }],
          parent: { name: "QrParent" },
        });
        const body = await (
          await adminGet(`/admin/listing/${parent.id}`)
        ).text();
        expect(body).toContain(`/admin/listing/${parent.id}/qr`);
        // A non-child parent keeps its public URL and both embed snippets, so the
        // suppression is genuinely conditional on being a child.
        expect(body).toContain(`/ticket/${parent.slug}`);
        expect(body).toContain(`embed-script-${parent.id}`);
        expect(body).toContain(`embed-iframe-${parent.id}`);
      });

      test("the child QR generator route 404s", async () => {
        const { child } = await makeParent({
          children: [{ name: "QrChild" }],
          parent: { name: "QrParent" },
        });
        const get = await adminGet(`/admin/listing/${child.id}/qr`);
        get.body?.cancel();
        expect(get.status).toBe(404);
        const json = await adminGet(`/admin/listing/${child.id}/qr.json`);
        json.body?.cancel();
        expect(json.status).toBe(404);
      });

      test("the public child QR image route 404s", async () => {
        const { child } = await makeParent({
          children: [{ name: "QrChild" }],
          parent: { name: "QrParent" },
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${child.slug}/qr`),
        );
        response.body?.cancel();
        expect(response.status).toBe(404);
      });
    });
  },
);
