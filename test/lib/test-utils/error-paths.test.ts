import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import type { Field } from "#shared/forms/field.ts";
import { expectStatus } from "#test-utils/assertions.ts";
import {
  createTestDb,
  createTestDbWithSetup,
  resetDb,
} from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { priceFormValue } from "#test-utils/db-helpers/listing-forms.ts";
import {
  createTestListing,
  deactivateTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { emailTestSandbox, validEmail } from "#test-utils/email.ts";
import { resetTestSession } from "#test-utils/internal.ts";
import { rejection } from "#test-utils/ledger.ts";
import {
  buildMigrationContext,
  unusedMigrationMember,
} from "#test-utils/migrations.ts";
import {
  errorResponse,
  installRecordingFetch,
  withBunnyDeleteCapture,
  withBunnyStorageStub,
  withCdnProxy,
  withCdnRejecting,
  withStorageMock,
} from "#test-utils/mocks.ts";
import { withRandomBytes } from "#test-utils/random.ts";
import { loginAsAdmin } from "#test-utils/session.ts";
import { invalidateTestDbCache } from "#test-utils/test-state.ts";
import { expectInvalidForm } from "#test-utils/validation.ts";

describe("test-utils — error paths & contracts", () => {
  afterEach(() => {
    resetDb();
  });

  describe("expectStatus", () => {
    test("returns the response when status matches", () => {
      const response = new Response("ok", { status: 200 });
      const result = expectStatus(200)(response);
      expect(result).toBe(response);
    });

    test("works with different status codes", () => {
      const response = new Response(null, { status: 404 });
      const result = expectStatus(404)(response);
      expect(result).toBe(response);
    });
  });

  describe("errorResponse", () => {
    test("creates a response factory with given status", () => {
      const make500 = errorResponse(500);
      const response = make500("Internal Server Error");
      expect(response.status).toBe(500);
    });

    test("includes the error message in the response body", async () => {
      const make400 = errorResponse(400);
      const response = make400("Bad Request");
      const body = await response.text();
      expect(body).toBe("Bad Request");
    });
  });

  describe("loginAsAdmin error path", () => {
    test("throws when CSRF token cannot be obtained from login response", async () => {
      // createTestDb without setup means no admin password exists
      // so login will fail and no session cookie is set
      await createTestDb();
      await expect(loginAsAdmin()).rejects.toThrow(
        "Failed to get CSRF token for admin login",
      );
    });
  });

  describe("getTestSession fallback to loginAsAdmin", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("falls back to loginAsAdmin when cached admin session is cleared", async () => {
      // Clear testSession and cachedAdminSession, but leave db working
      resetTestSession();
      invalidateTestDbCache();
      // createTestListing uses getTestSession internally
      // With cachedAdminSession null, it falls through to loginAsAdmin
      const listing = await createTestListing();
      expect(listing.id).toBeGreaterThan(0);
    });
  });

  describe("authenticatedFormRequest and createTestListing error paths", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("createTestListing throws on validation failure when name is empty", async () => {
      // Empty name triggers validation failure, returning 400 instead of 302
      await expect(createTestListing({ name: "" })).rejects.toThrow(
        "Failed to create listing: 400",
      );
    });

    test("authenticatedFormRequest throws on non-302 response via update", async () => {
      // Update with empty name triggers validation failure.
      // The update handler returns a 200 error page (not 302) on validation failure.
      const listing = await createTestListing();
      await expect(updateTestListing(listing.id, { name: "" })).rejects.toThrow(
        "Failed to update listing",
      );
    });
  });

  describe("formatPrice coverage", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("preserves existing unitPrice when update does not specify unitPrice", async () => {
      // Create listing with a unit price
      const listing = await createTestListing({ unitPrice: 2500 });
      expect(listing.unit_price).toBe(2500);
      // Update without specifying unitPrice -> formatPrice(undefined, 2500)
      const updated = await updateTestListing(listing.id, { maxAttendees: 50 });
      expect(updated.unit_price).toBe(2500);
      expect(updated.max_attendees).toBe(50);
    });

    test("preserves existing closesAt when update does not specify closesAt", async () => {
      const listing = await createTestListing({ closesAt: "2099-06-15T14:30" });
      expect(listing.closes_at).toBe("2099-06-15T14:30:00.000Z");
      const updated = await updateTestListing(listing.id, { maxAttendees: 50 });
      expect(updated.closes_at).toBe("2099-06-15T14:30:00.000Z");
      expect(updated.max_attendees).toBe(50);
    });
  });

  describe("createTestListing with null thankYouUrl", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates listing without thankYouUrl using ?? empty string fallback", async () => {
      const listing = await createTestListing({ thankYouUrl: undefined });
      expect(listing.id).toBeGreaterThan(0);
      // thankYouUrl: undefined triggers the default empty string
      expect(listing.thank_you_url).toBe("");
    });
  });

  describe("createTestAttendee error paths", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("throws when listing is deactivated", async () => {
      const listing = await createTestListing();
      await deactivateTestListing(listing.id);
      await expect(
        createTestAttendee(
          listing.id,
          listing.slug,
          "Test",
          "test@example.com",
        ),
      ).rejects.toThrow("Failed to create attendee");
    });

    test("throws when form submission returns error status (listing at capacity)", async () => {
      const listing = await createTestListing({
        maxAttendees: 1,
        maxQuantity: 1,
      });
      // Fill the listing
      await createTestAttendee(
        listing.id,
        listing.slug,
        "First",
        "first@example.com",
      );
      // Second attendee should fail because listing is full
      await expect(
        createTestAttendee(
          listing.id,
          listing.slug,
          "Second",
          "second@example.com",
        ),
      ).rejects.toThrow("Failed to create attendee");
    });
  });

  describe("updateTestListing listing not found after update", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("throws when listing does not exist", async () => {
      await expect(
        updateTestListing(99999, { maxAttendees: 50 }),
      ).rejects.toThrow("Listing not found: 99999");
    });
  });

  describe("strictly covered utility contracts", () => {
    test("priceFormValue formats minor units for form submission", () => {
      expect(priceFormValue(1234)).toBe("12.34");
      expect(priceFormValue(0)).toBe("0.00");
    });

    test("withRandomBytes pads missing deterministic bytes with zero", () => {
      withRandomBytes([7])(() => {
        const bytes = new Uint8Array(3);
        crypto.getRandomValues(bytes);
        expect([...bytes]).toEqual([7, 0, 0]);
      });
    });

    test("validEmail rejects invalid fixture addresses", () => {
      expect(validEmail("person@example.com")).toBe("person@example.com");
      expect(() => validEmail("not an address")).toThrow(
        "Test fixture is not a valid email",
      );
    });

    test("expectInvalidForm only accepts invalid form data", () => {
      const fields: Field[] = [
        { label: "Name", name: "name", required: true, type: "text" },
      ];

      expectInvalidForm(fields, { name: "" });
      expect(() => expectInvalidForm(fields, { name: "Alice" })).toThrow();
    });

    test("rejection returns the thrown error and fails on resolved promises", async () => {
      const thrown = await rejection(Promise.reject(new Error("boom")));

      expect(thrown.message).toBe("boom");
      await expect(rejection(Promise.resolve("ok"))).rejects.toThrow(
        "expected the promise to reject",
      );
    });

    test("migration helpers fail closed for unused members and no-op verifiers", async () => {
      await expect(unusedMigrationMember()).rejects.toThrow(
        "unused migration context member called",
      );

      const context = buildMigrationContext();
      const migration = context.additive({
        description: "test additive migration",
        id: "test-additive",
        requires: { newTables: ["example"] },
        up: async () => {},
      });

      expect(migration.id).toBe("test-additive");
      await migration.verify();
      await context.verifyRequirement({ columns: { example: ["id"] } })();
    });

    test("recording fetch records calls and falls through when respond returns null", async () => {
      const fetchMock = installRecordingFetch(() => null);
      try {
        const response = await fetch("data:text/plain,fallback");

        expect(await response.text()).toBe("fallback");
        expect(fetchMock.calls).toEqual([
          { body: null, url: "data:text/plain,fallback" },
        ]);
        expect(fetchMock.emailCall()).toBeUndefined();
      } finally {
        fetchMock.restore();
      }
    });

    test("Bunny storage stub intercepts storage URLs and leaves unrelated URLs alone", async () => {
      const seen: string[] = [];

      await withBunnyStorageStub(
        (url) => {
          seen.push(url);
          return new Response("stored");
        },
        async () => {
          const stored = await fetch(
            "https://storage.bunnycdn.com/testzone/file.txt",
          );
          const fallback = await fetch("data:text/plain,plain");

          expect(await stored.text()).toBe("stored");
          expect(await fallback.text()).toBe("plain");
        },
      );

      expect(seen).toEqual(["https://storage.bunnycdn.com/testzone/file.txt"]);
    });

    test("Bunny delete capture records storage deletes and permits custom intercepts", async () => {
      await withBunnyDeleteCapture(
        async (deletedUrls) => {
          const storageResponse = await fetch(
            "https://storage.bunnycdn.com/testzone/delete-me.txt",
          );
          const customResponse = await fetch("https://example.test/custom");
          const fallbackResponse = await fetch("data:text/plain,untouched");

          expect(storageResponse.status).toBe(200);
          expect(await customResponse.text()).toBe("custom");
          expect(await fallbackResponse.text()).toBe("untouched");
          expect(deletedUrls).toEqual([
            "https://storage.bunnycdn.com/testzone/delete-me.txt",
          ]);
        },
        {
          extraHandler: (url) =>
            url === "https://example.test/custom"
              ? Promise.resolve(new Response("custom"))
              : null,
        },
      );
    });

    test("storage mock covers storage, CDN, and fallback fetches", async () => {
      await withStorageMock(async (fetchCalls) => {
        const storage = await fetch(
          "https://storage.bunnycdn.com/testzone/upload.txt",
        );
        const cdn = await fetch("https://testzone.b-cdn.net/upload.txt");
        const fallback = await fetch("data:text/plain,local");

        expect(storage.status).toBe(201);
        expect(cdn.status).toBe(201);
        expect(await fallback.text()).toBe("local");
        expect(fetchCalls).toEqual([
          "https://storage.bunnycdn.com/testzone/upload.txt",
          "https://testzone.b-cdn.net/upload.txt",
          "data:text/plain,local",
        ]);
      });
    });

    test("CDN proxy helpers intercept storage URLs and restore fetch", async () => {
      await withCdnProxy(
        () => new Response("proxied", { status: 202 }),
        async () => {
          const proxied = await fetch(
            "https://storage.bunnycdn.com/testzone/proxied.txt",
          );
          const fallback = await fetch("data:text/plain,local");

          expect(proxied.status).toBe(202);
          expect(await proxied.text()).toBe("proxied");
          expect(await fallback.text()).toBe("local");
        },
      );

      await withCdnRejecting(new Error("cdn down"), async () => {
        await expect(
          fetch("https://storage.bunnycdn.com/testzone/fail.txt"),
        ).rejects.toThrow("cdn down");

        const fallback = await fetch("data:text/plain,still-local");
        expect(await fallback.text()).toBe("still-local");
      });
    });

    test("email sandbox replaces an existing fetch stub and restores all state", () => {
      const sandbox = emailTestSandbox();

      sandbox.stubFetch(() => Promise.resolve(new Response("first")));
      sandbox.stubFetch(() => Promise.resolve(new Response("second")));
      expect(sandbox.fetchStub).toBeDefined();

      sandbox.teardown();
      expect(sandbox.fetchStub).toBeUndefined();
    });
  });
});
