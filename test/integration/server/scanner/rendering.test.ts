/**
 * Rendering, asset and link tests for the QR scanner admin feature: the
 * scanner page template, the scanner.js bundle, the listing-page link, and
 * the admin guide.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectLoginRedirectWithReturn } from "#test-utils/login-redirect.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminGet } from "#test-utils/session.ts";

/** Get scanner page body text for a given listing */
const getScannerBody = async (listingId: number) => {
  const response = await adminGet(`/admin/listing/${listingId}/scanner`);
  return await response.text();
};

/** Create a test listing and return its scanner page body */
const createListingAndGetScannerBody = async () => {
  const listing = await createTestListing({ maxAttendees: 10 });
  const body = await getScannerBody(listing.id);
  return { body, listing };
};

describeWithEnv("QR scanner page, links and guide", { db: true }, () => {
  describe("GET /admin/listing/:id/scanner", () => {
    test("renders scanner page when authenticated", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const response = await adminGet(`/admin/listing/${listing.id}/scanner`);

      await expectHtmlResponse(
        response,
        200,
        "Scanner",
        "scanner-container",
        "scanner-video",
        "scanner-start",
        `data-scan-path="/admin/listing/${listing.id}/scan"`,
        "scanner.js",
        "scanner-confirm",
      );
    });

    test("redirects to the login flow with the page when not authenticated", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/scanner`,
      );
      expectLoginRedirectWithReturn(`/admin/listing/${listing.id}/scanner`)(
        response,
      );
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/99999/scanner");
      expect(response.status).toBe(404);
    });

    test("includes manual check-in form with combobox", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const body = await getScannerBody(listing.id);
      assertStringIncludes(body, "Manual Check-in");
      assertStringIncludes(body, "data-manual-checkin");
      assertStringIncludes(body, 'id="ticket-options"');
      assertStringIncludes(body, 'role="listbox"');
      assertStringIncludes(body, 'role="combobox"');
    });

    test("datalist shows the tickets each person still owes", async () => {
      const { listing } = await createTestAttendeeWithToken(
        "Dave Multi",
        "dave-multi@test.com",
        {},
        3,
      );
      const body = await getScannerBody(listing.id);
      assertStringIncludes(body, "Dave Multi (3 tickets)");
    });

    test("datalist shows a single ticket in the singular", async () => {
      const { listing } = await createTestAttendeeWithToken(
        "Eve Single",
        "eve-single@test.com",
      );
      const body = await getScannerBody(listing.id);
      assertStringIncludes(body, "Eve Single (1 ticket)");
    });
  });

  describe("scanner template", () => {
    test("contains CSRF token in meta tag", async () => {
      const { body } = await createListingAndGetScannerBody();
      assertStringIncludes(body, 'name="csrf-token"');
    });

    test("contains back link to listing page", async () => {
      const { listing, body } = await createListingAndGetScannerBody();
      assertStringIncludes(body, `/admin/listing/${listing.id}`);
      assertStringIncludes(body, listing.name);
    });
  });

  describe("GET /scanner.js", () => {
    test("serves scanner JavaScript bundle", async () => {
      const response = await awaitTestRequest("/scanner.js");

      expect(response.status).toBe(200);
      assertStringIncludes(
        response.headers.get("content-type") ?? "",
        "application/javascript",
      );
    });
  });

  describe("listing page scanner link", () => {
    test("scanner is a top-level tab, not an Actions-tab link", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const scannerHref = `/admin/listing/${listing.id}/scanner`;

      const overview = await adminGet(`/admin/listing/${listing.id}`);
      const overviewBody = await overview.text();
      assertStringIncludes(overviewBody, scannerHref);
      assertStringIncludes(overviewBody, "Scanner");

      // The tab strip renders on every tab (so the actions page still carries
      // ONE occurrence, the strip link) — but the Actions section's own
      // action-row markup for it must be gone.
      const actions = await adminGet(`/admin/listing/${listing.id}/actions`);
      const actionsBody = await actions.text();
      const occurrences = actionsBody.split(scannerHref).length - 1;
      expect(occurrences).toBe(1);
      assert(
        !actionsBody.includes(
          `<div class="entity-action"><a class="btn secondary" href="${scannerHref}"`,
        ),
      );
    });

    test("scanner tab is hidden for a purchase-only (no check-in) listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        purchaseOnly: true,
      });
      const response = await adminGet(`/admin/listing/${listing.id}`);
      const body = await response.text();
      assert(!body.includes(`/admin/listing/${listing.id}/scanner`));
    });
  });

  describe("GET /admin/guide", () => {
    test("renders guide page when authenticated", async () => {
      const response = await adminGet("/admin/guide");
      await expectHtmlResponse(
        response,
        200,
        "Guide",
        "QR scanner",
        "How do I use the QR scanner?",
        "stops a double-scan",
      );
    });

    test("redirects to the login flow with the page when not authenticated", async () => {
      const response = await awaitTestRequest("/admin/guide");

      expectLoginRedirectWithReturn("/admin/guide")(response);
    });

    test("documents modifiers and price values", async () => {
      const response = await adminGet("/admin/guide");
      const body = await response.text();

      assertStringIncludes(body, 'id="modifiers"');
      assertStringIncludes(body, "What are modifiers?");
      assertStringIncludes(body, "Fixed amount");
      assertStringIncludes(body, "10%");
      assertStringIncludes(body, "10x");
    });

    test("footer contains guide link", async () => {
      const response = await adminGet("/admin/guide");
      const body = await response.text();
      expect(body).toMatch(
        /<a[^>]*\bhref="\/admin\/guide"[^>]*>\s*Guide\s*<\/a>/,
      );
    });
  });
});
