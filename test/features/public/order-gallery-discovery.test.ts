/**
 * The /order gallery's share of the listing parent/child discovery rules: the
 * gallery omits a child as a selectable card, and a parent's selection
 * redirect never carries a child slug or a pre-fill its availability refuses.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingChildren } from "#db/listing-parents.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { makeParent } from "#test-utils/parents.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

/** Fetch the gallery body with the public site + order page enabled. */
const galleryBody = async (): Promise<string> => {
  await enablePublicSite();
  await settings.update.orderEnabled(true);
  const response = await handleRequest(mockRequest("/order"));
  return response.text();
};

/** Redirect Location for an /order selection. */
const orderRedirect = async (ids: number[]): Promise<string> => {
  await enablePublicSite();
  await settings.update.orderEnabled(true);
  const query = ids.map((id) => `select_${id}=1`).join("&");
  const response = await handleRequest(mockRequest(`/order?${query}`));
  response.body?.cancel();
  return response.headers.get("location") ?? "";
};

describeWithEnv(
  "listing parent discovery — /order gallery",
  { db: true, triggers: true },
  () => {
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
        await listingChildren.setIds(parent.id, [child.id]);
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
  },
);
