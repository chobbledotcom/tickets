import { assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { listingGroups } from "#db/groups/table.ts";
import {
  getAllListings,
  getListingWithCount,
  listingsTable,
} from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withDbFault } from "#test-utils/db-fault.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { baseListingForm } from "#test-utils/factories.ts";
import { mockMultipartRequest, withExpectedError } from "#test-utils/mocks.ts";
import {
  adminMultipartPost,
  setupListingAndLogin,
  testCookie,
} from "#test-utils/session.ts";
import { featureSetting } from "#test-utils/settings.ts";
import { expectTemporaryError } from "#test-utils/temporary-error.ts";

describeWithEnv("server listings > create", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/listing", () => {
    testRequiresAuth("/admin/listing", {
      body: {
        ...baseListingForm,
        name: "Test Listing",
      },
      multipart: true,
    });

    test("redirects to picker when posting a logistics template with logistics disabled", async () => {
      settings.setForTest(featureSetting());
      const { response } = await adminMultipartPost("/admin/listing", {
        ...baseListingForm,
        name: "Hireable",
        template_id: "hireable-item",
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
        ...baseListingForm,
        listing_type: "standard",
        name: "My Event",
        purchase_only: "",
        template_id: "one-off-event",
        uses_logistics: "",
      });
      expect(response.status).toBe(400);
      assertStringIncludes(await response.text(), "date is required");
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
      assertStringIncludes(await response.text(), 'value="online-digital"');
    });

    test("creates listing when authenticated", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        ...baseListingForm,
        name: "New Listing",
      });
      await expectFlashRedirect("/admin", "Listing created")(response);

      // Verify listing was actually created
      const listing = await getListingWithCount(1);
      expect(listing).not.toBeNull();
      expect(listing?.name).toBe("New Listing");
    });

    test("does not refresh after the listing commits and its activity write fails", async () => {
      const { response } = await withDbFault(
        `CREATE TRIGGER fail_listing_activity
         BEFORE INSERT ON activity_log
         WHEN NEW.listing_id IS NOT NULL
         BEGIN
           SELECT RAISE(ABORT, 'Listing activity write failed');
         END`,
        "fail_listing_activity",
        () =>
          withExpectedError(() =>
            adminMultipartPost("/admin/listing", {
              ...baseListingForm,
              max_attendees: "50",
              name: "Saved before error",
            }),
          ),
      );

      const listings = await getAllListings();
      expect(listings.map(({ name }) => name)).toEqual(["Saved before error"]);
      expect(listings[0]?.max_attendees).toBe(50);
      await expectTemporaryError(false)(response);
    });

    test("still creates when the read-back replica lags the just-committed write", async () => {
      // The primary read-back succeeds even while an optional replica read
      // still misses the newly committed row.
      // The optional replica read misses the row; the primary read-back the
      // create path actually uses must still find it.
      const readStub = stub(listingsTable.read, "one", () =>
        Promise.resolve(null),
      );
      try {
        const { response } = await adminMultipartPost("/admin/listing", {
          ...baseListingForm,
          name: "Lagged Listing",
        });
        await expectFlashRedirect("/admin", "Listing created")(response);
      } finally {
        readStub.restore();
      }

      // The row really was written (the stub only affected the replica read path).
      const listing = await getListingWithCount(1);
      expect(listing?.name).toBe("Lagged Listing");
    });

    test("refuses a webhook URL when creating listing in demo mode", async () => {
      setDemoModeForTest(true);

      const { response } = await adminMultipartPost("/admin/listing", {
        ...baseListingForm,
        name: "Demo Listing",
        webhook_url: "https://example.com/webhook",
      });

      expect([response.status, await getListingWithCount(1)]).toEqual([
        400,
        null,
      ]);
    });

    test("creates listing with group_id when provided", async () => {
      const group = await createTestGroup({
        name: "Listing Group",
        slug: "listing-group",
      });
      const { response } = await adminMultipartPost("/admin/listing", {
        ...baseListingForm,
        group_ids: String(group.id),
        name: "Grouped Listing",
      });
      await expectFlashRedirect("/admin", "Listing created")(response);

      const listing = await getListingWithCount(1);
      assertArrayIncludes(await listingGroups.getIds(listing!.id), [group.id]);
    });

    test("rejects non-existent group_id on create", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        ...baseListingForm,
        group_ids: "999",
        name: "Bad Group Listing",
      });
      expectStatus(400)(response);

      const listings = await getAllListings();
      expect(listings.map((e) => e.name)).not.toContain("Bad Group Listing");
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
        ...baseListingForm,
        group_ids: String(group.id),
        listing_type: "daily",
        name: "Daily Mismatch",
      });
      expectStatus(400)(response);
      const body = await response.clone().text();
      assertStringIncludes(body, "already contains standard listings");
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/listing",
          {
            ...baseListingForm,
            csrf_token: "invalid-csrf-token",
            name: "New Listing",
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
            ...baseListingForm,
            name: "New Listing",
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
      assertStringIncludes(html, `value="${group.id}"`);
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
        ...baseListingForm,
        name: "Duplicate Listing",
      });
      expect(response.status).toBe(400);
      assertStringIncludes(
        await response.text(),
        "Name is already in use by another listing or group",
      );
    });
  });
});
