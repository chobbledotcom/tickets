// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getGroupIdsByListingId } from "#shared/db/groups.ts";
import {
  getAllListings,
  getListing,
  listingsTable,
} from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockMultipartRequest } from "#test-utils/mocks.ts";
import {
  adminMultipartPost,
  setupListingAndLogin,
  testCookie,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > create", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/listing", () => {
    testRequiresAuth("/admin/listing", {
      body: {
        max_attendees: "100",
        max_quantity: "1",
        name: "Test Listing",
        thank_you_url: "https://example.com",
      },
      multipart: true,
    });

    test("redirects to picker when posting a logistics template with logistics disabled", async () => {
      settings.setForTest({ has_logistics: false });
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "100",
        max_quantity: "1",
        name: "Hireable",
        template_id: "hireable-item",
        thank_you_url: "https://example.com",
      });
      await expectHtmlResponse(
        response,
        200,
        "Add Listing",
        "Choose a listing type",
      );
    });

    test("returns date required error for one-off-event template with no date", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        listing_type: "standard",
        max_attendees: "100",
        max_quantity: "1",
        name: "My Event",
        purchase_only: "",
        template_id: "one-off-event",
        thank_you_url: "https://example.com",
        uses_logistics: "",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("date is required");
    });

    test("re-renders with carried template_id when create validation fails", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "100",
        max_quantity: "1",
        template_id: "online-digital",
        thank_you_url: "https://example.com",
        // name omitted → validation error
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('value="online-digital"');
    });

    test("creates listing when authenticated", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "50",
        max_quantity: "1",
        name: "New Listing",
        thank_you_url: "https://example.com/thanks",
      });
      await expectFlashRedirect("/admin", "Listing created")(response);

      // Verify listing was actually created
      const listing = await getListing(1);
      expect(listing).not.toBeNull();
      expect(listing?.name).toBe("New Listing");
    });

    test("still creates when the read-back replica lags the just-committed write", async () => {
      // Regression: the create resource wrote the row in a transaction (on the
      // primary), then read it back with a plain "read"-mode `findById`. Turso can
      // route that read to a replica still lagging the commit, so it returned null
      // and the handler crashed dereferencing `row.id` ("Cannot read properties of
      // null (reading 'id')"). The read-back now uses `findByIdPrimary`
      // (read-your-writes). Stub the replica read (`findById`) to miss the row —
      // the create must still succeed because it no longer reads back that way.
      const findByIdStub = stub(listingsTable, "findById", () =>
        Promise.resolve(null),
      );
      try {
        const { response } = await adminMultipartPost("/admin/listing", {
          max_attendees: "50",
          max_quantity: "1",
          name: "Lagged Listing",
          thank_you_url: "https://example.com/thanks",
        });
        await expectFlashRedirect("/admin", "Listing created")(response);
      } finally {
        findByIdStub.restore();
      }

      // The row really was written (the stub only affected the replica read path).
      const listing = await getListing(1);
      expect(listing?.name).toBe("Lagged Listing");
    });

    test("clears webhook URL when creating listing in demo mode", async () => {
      setDemoModeForTest(true);

      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Demo Listing",
        webhook_url: "https://example.com/webhook",
      });
      await expectFlashRedirect("/admin", "Listing created")(response);

      // Verify webhook_url was cleared
      const listing = await getListing(1);
      expect(listing).not.toBeNull();
      expect(listing?.webhook_url).toBe("");
    });

    test("creates listing with group_id when provided", async () => {
      const group = await createTestGroup({
        name: "Listing Group",
        slug: "listing-group",
      });
      const { response } = await adminMultipartPost("/admin/listing", {
        group_ids: String(group.id),
        max_attendees: "50",
        max_quantity: "1",
        name: "Grouped Listing",
        thank_you_url: "https://example.com/thanks",
      });
      await expectFlashRedirect("/admin", "Listing created")(response);

      const listing = await getListing(1);
      expect(await getGroupIdsByListingId(listing!.id)).toContain(group.id);
    });

    test("rejects non-existent group_id on create", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        group_ids: "999",
        max_attendees: "50",
        max_quantity: "1",
        name: "Bad Group Listing",
        thank_you_url: "https://example.com/thanks",
      });
      expectStatus(400)(response);

      const listings = await getAllListings();
      const match = listings.find((e) => e.name === "Bad Group Listing");
      expect(match).toBeUndefined();
    });

    test("rejects listing type mismatch with group on create", async () => {
      const group = await createTestGroup({
        name: "Standard Group",
        slug: "standard-group",
      });
      await createTestListing({
        groupId: group.id,
        listingType: "standard",
        maxAttendees: 50,
        name: "Standard Listing",
      });

      const { response } = await adminMultipartPost("/admin/listing", {
        group_ids: String(group.id),
        listing_type: "daily",
        max_attendees: "50",
        max_quantity: "1",
        name: "Daily Mismatch",
        thank_you_url: "https://example.com/thanks",
      });
      expectStatus(400)(response);
      const body = await response.clone().text();
      expect(body).toContain("already contains standard listings");
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/listing",
          {
            csrf_token: "invalid-csrf-token",
            max_attendees: "50",
            max_quantity: "1",
            name: "New Listing",
            thank_you_url: "https://example.com/thanks",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects missing CSRF token", async () => {
      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/listing",
          {
            max_attendees: "50",
            max_quantity: "1",
            name: "New Listing",
            thank_you_url: "https://example.com/thanks",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("stays on form with error on validation failure", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "",
        name: "",
        thank_you_url: "",
      });
      await expectHtmlResponse(response, 400, "Add Listing");
    });

    test("preserves submitted group selection when create fails validation", async () => {
      const group = await createTestGroup({ name: "Keep Me Group" });
      const { response } = await adminMultipartPost("/admin/listing", {
        group_ids: String(group.id),
        max_attendees: "",
        name: "",
        thank_you_url: "",
      });
      const html = await response.text();
      expect(response.status).toBe(400);
      // The submitted group checkbox re-renders as checked rather than empty, so
      // a fixed-and-resubmitted listing keeps its membership.
      expect(html).toContain(`value="${group.id}"`);
      expect(html).toMatch(
        new RegExp(
          `checked[^>]*value="${group.id}"|value="${group.id}"[^>]*checked`,
        ),
      );
    });

    test("rejects a duplicate listing name", async () => {
      // First, create a listing with a specific name
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Duplicate Listing",
        thankYouUrl: "https://example.com",
      });

      // A second listing may not reuse the name — names are unique across the
      // catalog so listings/groups can be referenced by name for import/export.
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Duplicate Listing",
        thank_you_url: "https://example.com",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        "Name is already in use by another listing or group",
      );
    });
  });
});
