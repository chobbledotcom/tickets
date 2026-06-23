import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { MAX_SEED_LISTINGS } from "#routes/admin/seeds.ts";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import { getAllListings } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { createSeeds } from "#shared/seeds.ts";
import {
  assertAdminHtml,
  awaitTestRequest,
  createTestManagerSession,
  describeWithEnv,
  expectFlashRedirect,
  extractCsrfToken,
  mockFormRequest,
  mockRequest,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("server (admin seeds)", { db: true }, () => {
  describe("GET /admin/seeds", () => {
    testRequiresAuth("/admin/seeds");

    test("returns 403 for non-owner", async () => {
      const managerCookie = await createTestManagerSession();
      const response = await awaitTestRequest("/admin/seeds", {
        cookie: managerCookie,
      });
      expect(response.status).toBe(403);
    });

    test("renders seeds page when authenticated", async () => {
      await assertAdminHtml("/admin/seeds", "Seed Data");
    });

    test("contains form with listing count and attendees per listing fields", async () => {
      await assertAdminHtml(
        "/admin/seeds",
        "listing_count",
        "attendees_per_listing",
        "Create Seed Data",
      );
    });

    test("contains back to dashboard link", async () => {
      await assertAdminHtml("/admin/seeds", 'href="/admin"');
    });
  });

  describe("POST /admin/seeds", () => {
    testRequiresAuth("/admin/seeds", {
      body: {
        attendees_per_listing: "0",
        listing_count: "1",
      },
      method: "POST",
    });

    test("returns 403 for non-owner", async () => {
      const managerCookie = await createTestManagerSession();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { attendees_per_listing: "0", listing_count: "1" },
          managerCookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("creates seed listings with no attendees", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            attendees_per_listing: "0",
            csrf_token: await testCsrfToken(),
            listing_count: "2",
          },
          cookie,
        ),
      );

      await expectFlashRedirect(
        "/admin/seeds",
        "Created 2 listing(s) with 0 attendee(s) total.",
      )(response);

      const listings = await getAllListings();
      expect(listings.length).toBe(2);
    });

    test("creates seed listings with attendees including paid and free", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            attendees_per_listing: "3",
            csrf_token: await testCsrfToken(),
            listing_count: "2",
          },
          await testCookie(),
        ),
      );

      await expectFlashRedirect(
        "/admin/seeds",
        expect.stringContaining("Created 2 listing"),
      )(response);

      const listings = await getAllListings();
      expect(listings.length).toBe(2);

      // Verify both paid and free listings are created
      const paidListing = listings.find((e) => e.unit_price > 0);
      const freeListing = listings.find((e) => e.unit_price === 0);
      expect(paidListing).toBeDefined();
      expect(freeListing).toBeDefined();

      for (const listing of listings) {
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(3);

        // Each attendee has a quantity between 1 and 4
        for (const attendee of attendees) {
          expect(attendee.quantity).toBeGreaterThanOrEqual(1);
          expect(attendee.quantity).toBeLessThanOrEqual(4);
        }

        // Total quantity does not exceed listing max_attendees (no overselling)
        const totalQuantity = attendees.reduce((sum, a) => sum + a.quantity, 0);
        expect(totalQuantity).toBeLessThanOrEqual(listing.max_attendees);
        // Listing max_attendees equals exactly the sum of attendee quantities
        expect(listing.max_attendees).toBe(totalQuantity);
      }
    });

    test("clamps listing count to max", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            attendees_per_listing: "0",
            csrf_token: await testCsrfToken(),
            listing_count: "999",
          },
          await testCookie(),
        ),
      );

      await expectFlashRedirect(
        "/admin/seeds",
        expect.stringContaining(`Created ${MAX_SEED_LISTINGS} listing`),
      )(response);
    });

    test("clamps negative values to minimum", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            attendees_per_listing: "-10",
            csrf_token: await testCsrfToken(),
            listing_count: "-5",
          },
          await testCookie(),
        ),
      );

      await expectFlashRedirect(
        "/admin/seeds",
        expect.stringContaining("Created 1 listing"),
      )(response);
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            attendees_per_listing: "0",
            csrf_token: "invalid",
            listing_count: "1",
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(403);
    });

    test("created listings are active", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            attendees_per_listing: "0",
            csrf_token: await testCsrfToken(),
            listing_count: "1",
          },
          await testCookie(),
        ),
      );

      const listings = await getAllListings();
      expect(listings[0]!.active).toBe(true);
      // With 0 attendees, max_attendees is 0 (sum of quantities)
      expect(listings[0]!.max_attendees).toBe(0);
    });

    test("redirects with error when seed creation fails", async () => {
      // Remove public key to cause createSeeds to fail
      await getDb().execute("DELETE FROM settings WHERE key = 'public_key'");
      settings.invalidateCache();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            attendees_per_listing: "0",
            csrf_token: await testCsrfToken(),
            listing_count: "1",
          },
          await testCookie(),
        ),
      );

      await expectFlashRedirect(
        "/admin/seeds",
        "Failed to create seed data. Ensure setup is complete.",
        false,
      )(response);
    });

    test("handles non-numeric listing count as 1", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            attendees_per_listing: "2",
            csrf_token: await testCsrfToken(),
            listing_count: "abc",
          },
          await testCookie(),
        ),
      );

      await expectFlashRedirect(
        "/admin/seeds",
        expect.stringContaining("Created 1 listing"),
      )(response);
    });

    test("handles non-numeric attendees per listing as 0", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          {
            attendees_per_listing: "abc",
            csrf_token: await testCsrfToken(),
            listing_count: "1",
          },
          await testCookie(),
        ),
      );

      await expectFlashRedirect(
        "/admin/seeds",
        expect.stringContaining("Created 1 listing"),
      )(response);
    });

    test("seeds a customisable-days listing with day prices", async () => {
      await createSeeds(1, 0);
      const { getAllListings } = await import("#shared/db/listings.ts");
      const listings = await getAllListings();
      const customisable = listings.find((l) => l.customisable_days);
      expect(customisable).toBeDefined();
      expect(Object.keys(customisable!.day_prices).length).toBeGreaterThan(0);
    });

    test("throws when public key is not configured", async () => {
      // Remove public key to cause createSeeds to throw
      await getDb().execute("DELETE FROM settings WHERE key = 'public_key'");
      settings.invalidateCache();

      await expect(createSeeds(1, 0)).rejects.toThrow(
        "Public key not configured",
      );
    });

    test("can seed multiple times additively", async () => {
      // First seed
      const get1 = await handleRequest(
        mockRequest("/admin/seeds", {
          headers: { cookie: await testCookie() },
        }),
      );
      const html1 = await get1.text();
      const csrf1 = extractCsrfToken(html1)!;

      await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { attendees_per_listing: "0", csrf_token: csrf1, listing_count: "2" },
          await testCookie(),
        ),
      );

      // Second seed
      const get2 = await handleRequest(
        mockRequest("/admin/seeds", {
          headers: { cookie: await testCookie() },
        }),
      );
      const html2 = await get2.text();
      const csrf2 = extractCsrfToken(html2)!;

      await handleRequest(
        mockFormRequest(
          "/admin/seeds",
          { attendees_per_listing: "0", csrf_token: csrf2, listing_count: "3" },
          await testCookie(),
        ),
      );

      const listings = await getAllListings();
      expect(listings.length).toBe(5);
    });
  });
});
