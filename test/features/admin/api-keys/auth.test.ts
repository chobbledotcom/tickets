import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { apiKeyLimiter } from "#shared/db/api-key-attempts.ts";
import { getDb, insert } from "#shared/db/client.ts";
import { MAX_APIKEY_ATTEMPTS } from "#shared/limits.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  createTestApiKeyFull,
  requestAsApiKey,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

describeWithEnv("API key authentication", { db: true }, () => {
  describe("Bearer token authentication", () => {
    test("authenticates /api/admin/* request with Bearer token", async () => {
      await createTestListing({ name: "Bearer Test" });

      const { apiKey } = await createTestApiKeyFull("Auth Test");

      await assertJson(
        handleRequest(requestAsApiKey("/api/admin/listings", apiKey)),
        200,
        (body) => {
          expect(body.listings).toBeDefined();
        },
      );
    });

    test("rejects invalid Bearer token", async () => {
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", "invalid-token"),
      );

      expect(response.status).toBe(401);
    });

    test("locks out Bearer auth after too many failed attempts", async () => {
      const { apiKey } = await createTestApiKeyFull("Rate Limited");
      // Saturate the failed-attempt limit for the test's "direct" IP. Once
      // locked, even a valid key is rejected until the lockout expires.
      for (let i = 0; i < MAX_APIKEY_ATTEMPTS; i++) {
        await apiKeyLimiter.record("direct");
      }
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey),
      );
      expect(response.status).toBe(401);
    });

    test("rejects request without auth", async () => {
      const response = await handleRequest(mockRequest("/admin/api-keys/docs"));

      expect(response.status).toBe(302);
    });
  });

  describe("admin JSON API", () => {
    test("GET /api/admin/listings returns listings via API key", async () => {
      await createTestListing({ name: "Test Listing" });

      const { apiKey } = await createTestApiKeyFull("Listings API");

      const body = await assertJson(
        handleRequest(requestAsApiKey("/api/admin/listings", apiKey)),
        200,
        (body) => {
          expect(body.listings).toBeDefined();
          expect(body.listings.length).toBeGreaterThan(0);
          expect(body.admin_level).toBe("owner");
        },
      );

      // Verify snake_case keys and no internal fields
      const listing = body.listings[0];
      expect(listing.name).toBe("Test Listing");
      expect(listing.max_attendees).toBeDefined();
      expect(listing.attendee_count).toBeDefined();
      expect(listing.listing_type).toBeDefined();
      expect(listing.slug_index).toBeUndefined();
    });

    test("GET /api/admin/listings returns listings via cookie+CSRF", async () => {
      await createTestListing({ name: "Cookie Listing" });

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await assertJson(
        handleRequest(
          requestAsSession("/api/admin/listings", { cookie, csrfToken }),
        ),
        200,
        (body) => {
          expect(body.listings).toBeDefined();
        },
      );
    });

    test("GET /api/admin/listings returns 401 for invalid API key", async () => {
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", "bad-key"),
      );

      expect(response.status).toBe(401);
    });

    test("GET /api/admin/listings returns 401 without auth", async () => {
      const response = await handleRequest(mockRequest("/api/admin/listings"));

      expect(response.status).toBe(401);
    });

    test("returns 401 when API key user no longer exists", async () => {
      const token = generateSecureToken();
      const keyIndex = await hmacHash(token);

      // Disable FK checks to insert an orphaned API key row
      await getDb().execute({ args: [], sql: "PRAGMA foreign_keys = OFF" });
      await getDb().execute(
        insert("api_keys", {
          created: new Date().toISOString(),
          key_index: keyIndex,
          last_used: "",
          name: "Ghost",
          user_id: 9999,
          wrapped_data_key: "dummy",
        }),
      );
      await getDb().execute({ args: [], sql: "PRAGMA foreign_keys = ON" });

      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", token),
      );

      expect(response.status).toBe(401);
    });

    test("returns 401 when API key wrapped data key is corrupted", async () => {
      const { apiKey, id } = await createTestApiKeyFull("Corrupt Key");

      // Corrupt the wrapped_data_key in the DB
      await getDb().execute({
        args: ["corrupted-data", id],
        sql: "UPDATE api_keys SET wrapped_data_key = ? WHERE id = ?",
      });

      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey),
      );

      expect(response.status).toBe(401);
    });

    test("GET /api/admin/listings serves a cookie without a CSRF header", async () => {
      await createTestListing({ name: "CSRF Listing" });
      const cookie = await testCookie();

      // A safe GET carries no body and can't mutate state, so a cookie session
      // need not (and a feed/browser client often cannot) send an x-csrf-token
      // header to read a JSON endpoint.
      await assertJson(
        handleRequest(
          mockRequest("/api/admin/listings", {
            headers: { cookie },
          }),
        ),
        200,
        (body) => {
          expect(body.listings).toBeDefined();
        },
      );
    });

    test("request succeeds when touchApiKeyLastUsed fails (fire-and-forget)", async () => {
      await createTestListing({ name: "Touch Test" });
      const { apiKey } = await createTestApiKeyFull("Touch Test Key");

      // Make touchApiKeyLastUsed throw via test hook
      const { setTouchOverride } = await import("#shared/test-overrides.ts");
      setTouchOverride(new Error("touch failed"));

      try {
        const response = await handleRequest(
          requestAsApiKey("/api/admin/listings", apiKey),
        );
        // Request should succeed despite touchApiKeyLastUsed throwing
        expect(response.status).toBe(200);
      } finally {
        setTouchOverride(null);
      }
    });
  });
});
