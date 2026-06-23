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
  createDailyTestListing,
  createTestAttendee,
  createTestGroup,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
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

describeWithEnv(
  "server > parents discovery suppression",
  { db: true, triggers: true },
  () => {
    describe("public listing cards (/listings)", () => {
      test("a visible child card has no standalone Book link", async () => {
        const parent = await createTestListing({ name: "Base unit" });
        const child = await createTestListing({ name: "Add-on" });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        // The child's card is still shown, but with no /ticket/<child> CTA.
        expect(body).toContain("Add-on");
        expect(body).not.toContain(`href="/ticket/${child.slug}"`);
        expect(body).toContain("Available as an add-on to another booking");
        // The parent keeps its normal Book link.
        expect(body).toContain(`href="/ticket/${parent.slug}"`);
      });

      test("a parent whose only child is sold out renders sold out", async () => {
        const parent = await createTestListing({ name: "Base unit" });
        const child = await createTestListing({
          maxAttendees: 1,
          name: "Add-on",
        });
        await createTestAttendee(child.id, child.slug, "Buyer", "b@x.com");
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).not.toContain(`href="/ticket/${parent.slug}"`);
        expect(body).toContain("Sold Out");
      });

      test("a parent whose only child has closed registration is sold out", async () => {
        const parent = await createTestListing({ name: "Base unit" });
        const pastDate = new Date(Date.now() - 60000)
          .toISOString()
          .slice(0, 16);
        const child = await createTestListing({
          closesAt: pastDate,
          name: "Add-on",
        });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).not.toContain(`href="/ticket/${parent.slug}"`);
        expect(body).toContain("Sold Out");
      });

      test("a parent with one bookable child keeps its Book link", async () => {
        const parent = await createTestListing({ name: "Base unit" });
        const child = await createTestListing({ name: "Add-on" });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).toContain(`href="/ticket/${parent.slug}"`);
      });

      test("a child whose only parent is deactivated renders unavailable", async () => {
        // The only parent page that could offer this child is deactivated, so
        // the "available as an add-on" CTA would point at nothing. A child is
        // never standalone-bookable (the slug guard rejects all children), so
        // the card renders as currently unavailable rather than a dead-end Book
        // link or a dead-end add-on note (Fix 1).
        const parent = await createTestListing({ name: "Base unit" });
        const child = await createTestListing({ name: "Add-on" });
        await setChildIds(parent.id, [child.id]);
        await deactivateTestListing(parent.id);
        const body = await publicBody("/listings");
        expect(body).toContain("Add-on");
        expect(body).not.toContain("Available as an add-on to another booking");
        expect(body).not.toContain(`href="/ticket/${child.slug}"`);
        expect(body).toContain("Currently Unavailable");
      });

      test("a child whose only parent is deactivated still 404s its ticket page", async () => {
        // The slug guard rejects every child regardless of parent.active, so the
        // advertised-as-unavailable child must not be standalone-bookable (Fix 1).
        const parent = await createTestListing({ name: "Base unit" });
        const child = await createTestListing({ name: "Add-on" });
        await setChildIds(parent.id, [child.id]);
        await deactivateTestListing(parent.id);
        await settings.update.showPublicSite(true);
        const response = await handleRequest(
          mockRequest(`/ticket/${child.slug}`),
        );
        response.body?.cancel();
        expect(response.status).toBe(404);
      });

      test("a child whose only parent is sold out renders unavailable", async () => {
        // The only parent page that could offer this child is itself sold out, so
        // it cannot fold the child into a booking — the "available as an add-on"
        // note would be a dead end. The child is never standalone-bookable, so its
        // card reads as currently unavailable (Fix 1, parentBookable sold-out).
        const parent = await createTestListing({
          maxAttendees: 1,
          name: "Base unit",
        });
        await createTestAttendee(parent.id, parent.slug, "Buyer", "b@x.com");
        const child = await createTestListing({ name: "Add-on" });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).toContain("Add-on");
        expect(body).not.toContain("Available as an add-on to another booking");
        expect(body).not.toContain(`href="/ticket/${child.slug}"`);
        expect(body).toContain("Currently Unavailable");
      });

      test("a child whose only parent has closed registration renders unavailable", async () => {
        // The only parent is past its own closes_at, so it cannot offer the child
        // — the add-on note would be a dead end and the child reads unavailable
        // (Fix 1, parentBookable registration-closed).
        const pastDate = new Date(Date.now() - 60000)
          .toISOString()
          .slice(0, 16);
        const parent = await createTestListing({
          closesAt: pastDate,
          name: "Base unit",
        });
        const child = await createTestListing({ name: "Add-on" });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).toContain("Add-on");
        expect(body).not.toContain("Available as an add-on to another booking");
        expect(body).not.toContain(`href="/ticket/${child.slug}"`);
        expect(body).toContain("Currently Unavailable");
      });

      test("a child with a bookable parent shows the add-on note", async () => {
        // The parent is active, not sold out, and not closed, so it can fold the
        // child into a booking — the child's card shows the add-on note and the
        // child's own standalone CTA stays suppressed (Fix 1, parentBookable
        // bookable case).
        const parent = await createTestListing({ name: "Base unit" });
        const child = await createTestListing({ name: "Add-on" });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).toContain("Available as an add-on to another booking");
        expect(body).not.toContain(`href="/ticket/${child.slug}"`);
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
        const body = await publicBody("/listings");
        expect(body).toContain("Available as an add-on to another booking");
        expect(body).not.toContain(`href="/ticket/${child.slug}"`);
      });

      test("a sold-out visible child shows sold out, not the add-on note", async () => {
        // The unavailable state must take precedence over the add-on note so the
        // card does not advertise an add-on the gate would reject (Fix 2).
        const parent = await createTestListing({ name: "Base unit" });
        const child = await createTestListing({
          maxAttendees: 1,
          name: "Add-on",
        });
        await createTestAttendee(child.id, child.slug, "Buyer", "b@x.com");
        await setChildIds(parent.id, [child.id]);
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
        const group = await createTestGroup({ maxAttendees: 2, name: "Pool" });
        const parent = await createTestListing({
          groupId: group.id,
          name: "Base unit",
        });
        const child = await createTestListing({
          groupId: group.id,
          name: "Add-on",
        });
        const filler = await createTestListing({
          groupId: group.id,
          name: "Filler",
        });
        await setChildIds(parent.id, [child.id]);
        // Consume one of the two group spots via an unrelated group member.
        await createTestAttendee(filler.id, filler.slug, "Buyer", "b@x.com");
        const body = await publicBody("/listings");
        expect(body).not.toContain(`href="/ticket/${parent.slug}"`);
        expect(body).toContain("Sold Out");
      });

      test("a parent + child sharing a capped group with 2 spots is bookable", async () => {
        // With two spots free, the combined parent+child demand fits, so the
        // parent keeps its Book link (Fix 4).
        const group = await createTestGroup({ maxAttendees: 2, name: "Pool" });
        const parent = await createTestListing({
          groupId: group.id,
          name: "Base unit",
        });
        const child = await createTestListing({
          groupId: group.id,
          name: "Add-on",
        });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).toContain(`href="/ticket/${parent.slug}"`);
      });

      test("a fixed multi-day daily parent whose only child can't fit the span is sold out", async () => {
        // The parent is a FIXED 3-day daily listing, so its children inherit a
        // 3-day span at the till. Its only child is a customisable daily add-on
        // that can be booked single days but never a 3-consecutive-day run (only
        // Mondays are bookable, so Mon–Wed always hits an unbookable Tue/Wed). A
        // span-blind discovery check (any one-day start exists) would advertise
        // the parent, but the gate's date union span-constrains it to empty and
        // the submit rejects — so it must read sold out (Fix 1).
        const parent = await createDailyTestListing({
          customisableDays: false,
          durationDays: 3,
          name: "3-day base",
        });
        const child = await createDailyTestListing({
          bookableDays: ["Monday"],
          customisableDays: true,
          dayPrices: { 1: 1000, 3: 3000 },
          durationDays: 3,
          name: "Span add-on",
        });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).not.toContain(`href="/ticket/${parent.slug}"`);
        expect(body).toContain("Sold Out");
      });

      test("a fixed multi-day daily parent whose child can fit the span is advertised", async () => {
        // Same fixed 3-day parent, but the child can be booked any weekday, so a
        // Mon–Wed 3-day run is valid — the parent keeps its Book link (Fix 1).
        const parent = await createDailyTestListing({
          customisableDays: false,
          durationDays: 3,
          name: "3-day base",
        });
        const child = await createDailyTestListing({
          customisableDays: true,
          dayPrices: { 1: 1000, 3: 3000 },
          durationDays: 3,
          name: "Span add-on",
        });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).toContain(`href="/ticket/${parent.slug}"`);
      });

      test("a daily parent whose only child has disjoint bookable weekdays is sold out (Fix 5)", async () => {
        // Both are single-day daily listings, but the parent is bookable only on
        // Mondays and its only child only on Tuesdays. The child has a bookable
        // start on its own calendar (Tuesday), so a child-calendar-only check
        // would still advertise the parent — yet there is NO date the parent can
        // offer on which the child is bookable, so `getTicketContext`'s date union
        // renders empty and the parent must read sold out (Fix 5).
        const parent = await createDailyTestListing({
          bookableDays: ["Monday"],
          name: "Monday base",
        });
        const child = await createDailyTestListing({
          bookableDays: ["Tuesday"],
          name: "Tuesday add-on",
        });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).not.toContain(`href="/ticket/${parent.slug}"`);
        expect(body).toContain("Sold Out");
      });

      test("a daily parent whose child shares a bookable weekday stays advertised (Fix 5)", async () => {
        // The child is bookable on a weekday the parent also offers (Monday), so
        // there is an overlapping date the gate can serve — the parent keeps its
        // Book link (the Fix 5 overlap is satisfied, not over-eager).
        const parent = await createDailyTestListing({
          bookableDays: ["Monday"],
          name: "Monday base",
        });
        const child = await createDailyTestListing({
          bookableDays: ["Monday", "Tuesday"],
          name: "Mon/Tue add-on",
        });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).toContain(`href="/ticket/${parent.slug}"`);
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
        const group = await createTestGroup({ maxAttendees: 2, name: "Pool" });
        const parent = await createTestListing({
          groupId: group.id,
          name: "Base unit",
        });
        const child = await createTestListing({
          groupId: group.id,
          name: "Add-on",
        });
        const filler = await createTestListing({
          groupId: group.id,
          name: "Filler",
        });
        await setChildIds(parent.id, [child.id]);
        await createTestAttendee(filler.id, filler.slug, "Buyer", "b@x.com");
        const body = await publicBody("/listings");
        expect(body).toContain("Add-on");
        expect(body).not.toContain("Available as an add-on to another booking");
      });

      test("a child whose only parent shares a 2-spot capped group shows the add-on note", async () => {
        // Two spots free ⇒ the combined parent+child demand fits, so the parent
        // can offer the child and the add-on note appears (Fix 5).
        const group = await createTestGroup({ maxAttendees: 2, name: "Pool" });
        const parent = await createTestListing({
          groupId: group.id,
          name: "Base unit",
        });
        const child = await createTestListing({
          groupId: group.id,
          name: "Add-on",
        });
        await setChildIds(parent.id, [child.id]);
        const body = await publicBody("/listings");
        expect(body).toContain("Available as an add-on to another booking");
      });
    });

    describe("RSS/ICS feeds", () => {
      test("omits a child and a no-bookable-child parent, keeps a normal one", async () => {
        const parent = await createTestListing({ name: "FeedParent" });
        const child = await createTestListing({ name: "FeedChild" });
        await deactivateTestListing(child.id);
        await setChildIds(parent.id, [child.id]);
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
        const parent = await createTestListing({ name: "VisParent" });
        const child = await createTestListing({ name: "VisChild" });
        await setChildIds(parent.id, [child.id]);
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
        const parent = await createTestListing({ name: "GalParent" });
        const child = await createTestListing({ name: "GalChild" });
        await setChildIds(parent.id, [child.id]);
        const body = await galleryBody();
        expect(body).toContain(`name="select_${parent.id}"`);
        expect(body).not.toContain(`name="select_${child.id}"`);
        expect(body).not.toContain("GalChild");
      });

      test("a selection redirect never contains a child slug", async () => {
        const parent = await createTestListing({ name: "GalParent" });
        const child = await createTestListing({ name: "GalChild" });
        await setChildIds(parent.id, [child.id]);
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
        const parent = await createTestListing({ name: "MbParent" });
        const child = await createTestListing({ name: "MbChild" });
        const plain = await createTestListing({ name: "MbPlain" });
        await setChildIds(parent.id, [child.id]);
        const body = await (await adminGet("/admin/")).response.text();
        expect(body).toContain(`data-multi-booking-slug="${parent.slug}"`);
        expect(body).toContain(`data-multi-booking-slug="${plain.slug}"`);
        expect(body).not.toContain(`data-multi-booking-slug="${child.slug}"`);
      });
    });

    describe("per-listing share / QR generators", () => {
      test("the child detail page suppresses the share/QR affordances", async () => {
        const parent = await createTestListing({ name: "QrParent" });
        const child = await createTestListing({ name: "QrChild" });
        await setChildIds(parent.id, [child.id]);
        const body = await (
          await adminGet(`/admin/listing/${child.id}`)
        ).response.text();
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
        const parent = await createTestListing({ name: "QrParent" });
        const child = await createTestListing({ name: "QrChild" });
        await setChildIds(parent.id, [child.id]);
        const body = await (
          await adminGet(`/admin/listing/${parent.id}`)
        ).response.text();
        expect(body).toContain(`/admin/listing/${parent.id}/qr`);
        // A non-child parent keeps its public URL and both embed snippets, so the
        // suppression is genuinely conditional on being a child.
        expect(body).toContain(`/ticket/${parent.slug}`);
        expect(body).toContain(`embed-script-${parent.id}`);
        expect(body).toContain(`embed-iframe-${parent.id}`);
      });

      test("the child QR generator route 404s", async () => {
        const parent = await createTestListing({ name: "QrParent" });
        const child = await createTestListing({ name: "QrChild" });
        await setChildIds(parent.id, [child.id]);
        const get = await adminGet(`/admin/listing/${child.id}/qr`);
        get.response.body?.cancel();
        expect(get.response.status).toBe(404);
        const json = await adminGet(`/admin/listing/${child.id}/qr.json`);
        json.response.body?.cancel();
        expect(json.response.status).toBe(404);
      });

      test("the public child QR image route 404s", async () => {
        const parent = await createTestListing({ name: "QrParent" });
        const child = await createTestListing({ name: "QrChild" });
        await setChildIds(parent.id, [child.id]);
        const response = await handleRequest(
          mockRequest(`/ticket/${child.slug}/qr`),
        );
        response.body?.cancel();
        expect(response.status).toBe(404);
      });
    });
  },
);
