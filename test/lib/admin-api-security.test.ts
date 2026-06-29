import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  createTestApiKeyToken,
  describeWithEnv,
  getTestSession,
  requestAsApiKey,
  requestAsSession,
} from "#test-utils";
import { createTestListing } from "#test-utils/db-helpers.ts";

describeWithEnv("admin API security", { db: true }, () => {
  describe("malformed JSON with API key auth", () => {
    test("POST /api/admin/listings returns 400 for malformed JSON", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("PUT /api/admin/listings/:id returns 400 for malformed JSON", async () => {
      const listing = await createTestListing();
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey(`/api/admin/listings/${listing.id}`, apiKey, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "PUT",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("malformed JSON on POST does not create an listing", async () => {
      const apiKey = await createTestApiKeyToken();
      const before = await (
        await import("#shared/db/listings.ts")
      ).getAllListings();
      const beforeCount = before.length;

      await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );

      const after = await (
        await import("#shared/db/listings.ts")
      ).getAllListings();
      expect(after.length).toBe(beforeCount);
    });

    test("malformed JSON on PUT does not mutate the listing", async () => {
      const listing = await createTestListing({ name: "Original Name" });
      const apiKey = await createTestApiKeyToken();

      await handleRequest(
        requestAsApiKey(`/api/admin/listings/${listing.id}`, apiKey, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "PUT",
        }),
      );

      const refreshed = await (
        await import("#shared/db/listings.ts")
      ).getListingWithCount(listing.id);
      expect(refreshed!.name).toBe("Original Name");
    });
  });

  describe("malformed JSON with cookie auth", () => {
    test("POST /api/admin/listings returns 400 with valid CSRF token", async () => {
      const session = await getTestSession();
      const response = await handleRequest(
        requestAsSession("/api/admin/listings", session, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("PUT /api/admin/listings/:id returns 400 with valid CSRF token", async () => {
      const listing = await createTestListing();
      const session = await getTestSession();
      const response = await handleRequest(
        requestAsSession(`/api/admin/listings/${listing.id}`, session, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "PUT",
        }),
      );
      expect(response.status).toBe(400);
    });
  });

  describe("missing or wrong content-type for mutating requests", () => {
    test("POST /api/admin/listings without content-type returns 400", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey, {
          body: JSON.stringify({ max_attendees: 10, name: "Test" }),
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    const assertListingRequestRejects400 = async (
      method: string,
      bodyFn: (listing: { id: number; name: string }) => string,
      urlFn: (listing: { id: number; name: string }) => string,
    ): Promise<void> => {
      const listing = await createTestListing();
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey(urlFn(listing), apiKey, {
          body: bodyFn(listing),
          method,
        }),
      );
      expect(response.status).toBe(400);
    };

    test("PUT /api/admin/listings/:id without content-type returns 400", () =>
      assertListingRequestRejects400(
        "PUT",
        () => JSON.stringify({ name: "Updated" }),
        ({ id }) => `/api/admin/listings/${id}`,
      ));

    test("POST /api/admin/listings with text/plain content-type returns 400", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey, {
          body: JSON.stringify({ max_attendees: 10, name: "Test" }),
          headers: { "content-type": "text/plain" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("body-bearing DELETE without content-type is rejected", () =>
      assertListingRequestRejects400(
        "DELETE",
        ({ name }) => JSON.stringify({ confirm_identifier: name }),
        ({ id }) => `/api/admin/listings/${id}`,
      ));

    test("treats uppercase Content-Type the same as lowercase (RFC 7231)", async () => {
      const apiKey = await createTestApiKeyToken();
      const body = JSON.stringify({ max_attendees: 10, name: "Case Test" });

      const lower = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey, {
          body,
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      const upper = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey, {
          body,
          headers: { "content-type": "APPLICATION/JSON" },
          method: "POST",
        }),
      );
      // RFC 7231: media types are case-insensitive. Both requests must produce
      // the same response — in particular the uppercase form must not be
      // rejected as a missing/wrong content-type.
      expect(upper.status).toBe(lower.status);
    });
  });

  describe("JSON body shape validation", () => {
    test("POST /api/admin/listings returns 400 for JSON array body", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey, {
          body: "[]",
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("POST /api/admin/listings returns 400 for JSON null body", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey, {
          body: "null",
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("POST /api/admin/listings returns 400 for JSON primitive body", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey, {
          body: '"just a string"',
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });
  });
});
