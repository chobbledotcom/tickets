import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { groups } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import { createTestGroup, createTestListing, jsonRequest } from "#test-utils";

import {
  bookListing,
  describePublicApi,
  expectBookedTo,
  expectCorsHeaders,
  fetchAvailability,
  fetchListingBySlug,
  fetchListingsList,
} from "./helpers.ts";

describePublicApi(() => {
  describe("OPTIONS /api/*", () => {
    test("returns 204 with CORS headers for listings", async () => {
      const response = await handleRequest(
        jsonRequest("/api/listings", { method: "OPTIONS" }),
      );
      expect(response.status).toBe(204);
      expectCorsHeaders(response);
      expect(response.headers.get("access-control-allow-methods")).toBe(
        "GET, POST, OPTIONS",
      );
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "content-type",
      );
    });

    test("returns 204 for listing slug path", async () => {
      const response = await handleRequest(
        jsonRequest("/api/listings/test-slug", { method: "OPTIONS" }),
      );
      expect(response.status).toBe(204);
      expectCorsHeaders(response);
    });

    test("returns 204 for availability path", async () => {
      const response = await handleRequest(
        jsonRequest("/api/listings/test-slug/availability", {
          method: "OPTIONS",
        }),
      );
      expect(response.status).toBe(204);
      expectCorsHeaders(response);
    });

    test("returns 204 for book path", async () => {
      const response = await handleRequest(
        jsonRequest("/api/listings/test-slug/book", { method: "OPTIONS" }),
      );
      expect(response.status).toBe(204);
      expectCorsHeaders(response);
    });
  });

  describe("API disabled", () => {
    test("returns 404 when public API setting is disabled", async () => {
      await settings.update.showPublicApi(false);
      const response = await handleRequest(jsonRequest("/api/listings"));
      expect(response.status).toBe(404);
    });
  });

  describe("booking listing_id manipulation", () => {
    /** A booking `target` and a decoy `other`, both 50-seat, for the tests that
     *  must ignore an id/slug injected into the JSON body. */
    const targetAndDecoy = async () => {
      const target = await createTestListing({ maxAttendees: 50 });
      const other = await createTestListing({ maxAttendees: 50 });
      return { other, target };
    };

    test("ignores listing_id in JSON body", async () => {
      const { other, target } = await targetAndDecoy();

      const { response } = await bookListing(target.slug, {
        email: "mallory@example.com",
        listing_id: other.id,
        name: "Mallory",
      });
      expect(response.status).toBe(200);

      // Verify booking went to target (URL slug), not other (injected id)
      await expectBookedTo(target.id, other.id);
    });

    test("returns 404 for non-existent slug even with valid listing_id in body", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });

      const { response } = await bookListing("nonexistent", {
        email: "mallory@example.com",
        listing_id: listing.id,
        name: "Mallory",
      });
      expect(response.status).toBe(404);

      // Verify no booking was created
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(0);
    });

    test("ignores slug field in JSON body", async () => {
      const { other, target } = await targetAndDecoy();

      const { response } = await bookListing(target.slug, {
        email: "mallory@example.com",
        name: "Mallory",
        slug: other.slug,
      });
      expect(response.status).toBe(200);

      // Booking goes to URL slug, body slug is ignored
      await expectBookedTo(target.id, other.id);
    });
  });

  describe("hidden package members are never exposed by the API", () => {
    /** A hidden package with one member listing, returning the member. */
    const hiddenPackageMember = async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Hidden Bundle",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      return createTestListing({ groupId: group.id, name: "Secret Member" });
    };

    test("lists the bundle, not the member, on GET /api/listings", async () => {
      await hiddenPackageMember();
      const { listings } = await fetchListingsList();
      expect(listings).toEqual([]);
      // The package itself is a first-class product: discoverable by
      // name/slug with its /ticket booking URL, members withheld.
      const raw = await (
        await handleRequest(jsonRequest("/api/listings"))
      ).json();
      expect(raw.packages).toHaveLength(1);
      expect(raw.packages[0].name).toBe("Hidden Bundle");
      expect(raw.packages[0].url).toBe(`/ticket/${raw.packages[0].slug}`);
    });

    test("404s the member's detail, availability and book endpoints", async () => {
      const member = await hiddenPackageMember();
      expect((await fetchListingBySlug(member.slug)).response.status).toBe(404);
      expect((await fetchAvailability(member.slug)).response.status).toBe(404);
      expect((await bookListing(member.slug)).response.status).toBe(404);
    });

    test("a VISIBLE package member stays listable and bookable", async () => {
      const group = await createTestGroup({ isPackage: true, name: "Open" });
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Open Member",
      });
      const { listings } = await fetchListingsList();
      expect(listings.map((l) => l.slug)).toContain(member.slug);
      expect((await fetchListingBySlug(member.slug)).response.status).toBe(200);
    });
  });
});
