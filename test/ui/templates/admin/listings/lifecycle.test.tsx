import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminDeactivateListingPage,
  adminListingDeletePage,
  adminReactivateListingPage,
} from "#templates/admin/listings/lifecycle.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const listing = testListingWithCount({
  attendee_count: 3,
  id: 7,
  name: "Summer Camp & Fun",
});

describe("listing lifecycle confirm pages", () => {
  beforeAll(setupAdminPageTest);

  test("delete page renders the warning, prompt, and dangerous submit", () => {
    const html = adminListingDeletePage(listing, OWNER_SESSION);

    expectIncludesAll(html, [
      'action="/admin/listing/7/delete"',
      "<strong>Warning:</strong> This permanently deletes the listing",
      "Its 3 attendee(s) will be unlinked",
      "To delete this listing, type its name &quot;Summer Camp &amp; Fun&quot; into the box below:",
      'name="confirm_identifier" placeholder="Summer Camp &amp; Fun" required',
      '<button class="danger" type="submit">',
      "/icons.svg#trash-2",
      "Delete Listing",
      "<title>Delete: Summer Camp &amp; Fun",
      // Confirm pages live under the Home nav, not a section's.
      '<a class="active" href="/admin/"',
    ]);
  });

  test("delete page renders a rejected-submit error", () => {
    const html = adminListingDeletePage(
      listing,
      OWNER_SESSION,
      "Listing name does not match.",
    );

    assertStringIncludes(html, "Listing name does not match.");
  });

  test("deactivate page lists every effect with the dangerous submit", () => {
    const html = adminDeactivateListingPage(listing, OWNER_SESSION);

    expectIncludesAll(html, [
      'action="/admin/listing/7/deactivate"',
      "<strong>Warning:</strong> Deactivating this listing will:",
      "<li>Return a 404 error on the public ticket page</li>",
      "<li>Prevent new registrations</li>",
      "<li>Reject any pending payments</li>",
      "<p>Existing attendees will not be affected.</p>",
      "To deactivate this listing, type its name &quot;Summer Camp &amp; Fun&quot; into the box below:",
      'name="confirm_identifier" placeholder="Summer Camp &amp; Fun" required',
      '<button class="danger" type="submit">',
      "Deactivate Listing",
      "<title>Deactivate: Summer Camp &amp; Fun",
    ]);
  });

  test("reactivate page explains the effect with a non-dangerous submit", () => {
    const html = adminReactivateListingPage(listing, OWNER_SESSION);

    expectIncludesAll(html, [
      'action="/admin/listing/7/reactivate"',
      "<p>Reactivating this listing will make it available for registrations again.</p>",
      "<p>The public ticket page will be accessible and new attendees can register.</p>",
      "To reactivate this listing, type its name &quot;Summer Camp &amp; Fun&quot; into the box below:",
      'name="confirm_identifier" placeholder="Summer Camp &amp; Fun" required',
    ]);
    assert(!html.includes('<button class="danger" type="submit">'));
    expectIncludesAll(html, [
      "/icons.svg#check",
      "Reactivate Listing",
      "<title>Reactivate: Summer Camp &amp; Fun",
    ]);
  });
});
