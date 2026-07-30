import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getDb } from "#shared/db/client.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { DEMO_NAMES } from "#shared/demo/samples.ts";
import { createSeeds } from "#shared/seeds.ts";
import {
  assertAdminHtml,
  expectFlashRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { extractCsrfToken } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  awaitTestRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { postSeeds } from "#test-utils/seeds.ts";
import { createTestManagerSession, testCookie } from "#test-utils/session.ts";

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
      await assertAdminHtml("/admin/seeds", "Seed data");
    });

    test("contains form with listing count and attendees per listing fields", async () => {
      await assertAdminHtml(
        "/admin/seeds",
        "listing_count",
        "attendees_per_listing",
        "Create seed data",
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

    test("creates seed listings with attendees including paid and free", async () => {
      const response = await postSeeds({
        attendees_per_listing: "3",
        listing_count: "2",
      });

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

    // Owns the direct decrypt contract for seeded attendees; the story
    // `@case:seeds.what-was-made-can-be-read-everywhere` covers the page.
    test("seeded attendees decrypt with real demo details", async () => {
      await postSeeds({ attendees_per_listing: "1", listing_count: "1" });

      const [listing] = await getAllListings();
      const raw = await getAttendeesRaw(listing!.id);
      const decrypted = await decryptAttendees(raw, await getTestPrivateKey());
      expect(decrypted.length).toBe(1);
      expect(DEMO_NAMES).toContain(decrypted[0]!.name);
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
      await postSeeds({ attendees_per_listing: "0", listing_count: "1" });

      const listings = await getAllListings();
      expect(listings[0]!.active).toBe(true);
      // With 0 attendees, max_attendees is 0 (sum of quantities)
      expect(listings[0]!.max_attendees).toBe(0);
    });

    test("seeds a customisable-days listing with day prices", async () => {
      await createSeeds(1, 0);
      const { getListingDayPrices } = await import(
        "#shared/db/listing-prices.ts"
      );
      const listings = await getAllListings();
      const customisable = listings.find((l) => l.customisable_days);
      expect(customisable).toBeDefined();
      // The demo day prices are 1/2/3-day counts (day prices are no longer a
      // listings column — they are seeded as day_count rows in listing_prices).
      const dayPrices = customisable!.day_prices;
      expect(
        Object.keys(dayPrices)
          .map(Number)
          .sort((x, y) => x - y),
      ).toEqual([1, 2, 3]);
      // The projected value matches the stored day_count rows exactly.
      expect(await getListingDayPrices(customisable!.id)).toEqual(dayPrices);
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
