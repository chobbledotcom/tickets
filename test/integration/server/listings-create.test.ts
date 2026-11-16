import { assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getAllListings, getListingWithCount } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { sql } from "#db/sql.ts";
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
import { submitListingCreate } from "#test-utils/listing-submits.ts";
import { mockMultipartRequest, withExpectedError } from "#test-utils/mocks.ts";
import {
  adminMultipartPost,
  setupListingAndLogin,
  testCookie,
} from "#test-utils/session.ts";
import { featureSetting } from "#test-utils/settings.ts";
import { sqlText } from "#test-utils/sql-text.ts";
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
      const { response } = await submitListingCreate({
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

    for (const [name, boxes, shown] of [
      [
        "returns date required error for one-off-event template with no date",
        {
          listing_type: "standard",
          purchase_only: "",
          template_id: "one-off-event",
          uses_logistics: "",
        },
        "date is required",
      ],
      [
        "re-renders with carried template_id when create validation fails",
        { name: "", template_id: "online-digital" },
        'value="online-digital"',
      ],
    ] as const) {
      test(name, async () => {
        const { response } = await submitListingCreate(boxes);
        expect(response.status).toBe(400);
        assertStringIncludes(await response.text(), shown);
      });
    }

    test("creates listing when authenticated", async () => {
      const { response } = await submitListingCreate({
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
        sql`CREATE TRIGGER fail_listing_activity
         BEFORE INSERT ON activity_log
         WHEN NEW.listing_id IS NOT NULL
         BEGIN
           SELECT RAISE(ABORT, 'Listing activity write failed');
         END`,
        "fail_listing_activity",
        () =>
          withExpectedError(() =>
            submitListingCreate({
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
      // A lagging replica: each listings read off the primary misses the new
      // listing, the first in this database. The primary read-back that the
      // create path uses must still find it.
      const db = getDb();
      const realExecute = db.execute.bind(db);
      const readStub = stub(db, "execute", async (...args) => {
        const result = await realExecute(
          ...(args as Parameters<typeof realExecute>),
        );
        if (!/\bFROM listings\b/.test(String(sqlText(args[0])))) return result;
        const rows = result.rows.filter((row) => row.id !== 1);
        return {
          ...result,
          rows,
          toJSON: () => ({ ...result.toJSON(), rows }),
        };
      });
      try {
        const { response } = await submitListingCreate({
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

      const { response } = await submitListingCreate({
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
      const { response } = await submitListingCreate({
        group_ids: String(group.id),
        name: "Grouped Listing",
      });
      await expectFlashRedirect("/admin", "Listing created")(response);

      const listing = await getListingWithCount(1);
      assertArrayIncludes(await listingGroups.getIds(listing!.id), [group.id]);
    });

    test("rejects non-existent group_id on create", async () => {
      const { response } = await submitListingCreate({
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

      const { response } = await submitListingCreate({
        group_ids: String(group.id),
        listing_type: "daily",
        name: "Daily Mismatch",
      });
      expectStatus(400)(response);
      const body = await response.clone().text();
      assertStringIncludes(body, "already contains standard listings");
    });

    for (const [name, token] of [
      ["rejects invalid CSRF token", { csrf_token: "invalid-csrf-token" }],
      ["rejects missing CSRF token", {}],
    ] as const) {
      test(name, async () => {
        const response = await handleRequest(
          mockMultipartRequest(
            "/admin/listing",
            { ...baseListingForm, ...token, name: "New Listing" },
            await testCookie(),
          ),
        );
        await expectHtmlResponse(response, 403, "Invalid CSRF token");
      });
    }

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
      const { response } = await submitListingCreate({
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
