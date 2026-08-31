import { expect } from "@std/expect";
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

    expect(html).toContain('action="/admin/listing/7/delete"');
    expect(html).toContain(
      "<strong>Warning:</strong> This permanently deletes the listing",
    );
    expect(html).toContain("Its 3 attendee(s) will be unlinked");
    expect(html).toContain(
      "To delete this listing, type its name &quot;Summer Camp &amp; Fun&quot; into the box below:",
    );
    expect(html).toContain(
      'name="confirm_identifier" placeholder="Summer Camp &amp; Fun" required',
    );
    expect(html).toContain('<button class="danger" type="submit">');
    expect(html).toContain("/icons.svg#trash-2");
    expect(html).toContain("Delete Listing");
    expect(html).toContain("<title>Delete: Summer Camp &amp; Fun");
    // Confirm pages live under the Home nav, not a section's.
    expect(html).toContain('<a class="active" href="/admin/"');
  });

  test("delete page renders a rejected-submit error", () => {
    const html = adminListingDeletePage(
      listing,
      OWNER_SESSION,
      "Listing name does not match.",
    );

    expect(html).toContain("Listing name does not match.");
  });

  test("deactivate page lists every effect with the dangerous submit", () => {
    const html = adminDeactivateListingPage(listing, OWNER_SESSION);

    expect(html).toContain('action="/admin/listing/7/deactivate"');
    expect(html).toContain(
      "<strong>Warning:</strong> Deactivating this listing will:",
    );
    expect(html).toContain(
      "<li>Return a 404 error on the public ticket page</li>",
    );
    expect(html).toContain("<li>Prevent new registrations</li>");
    expect(html).toContain("<li>Reject any pending payments</li>");
    expect(html).toContain("<p>Existing attendees will not be affected.</p>");
    expect(html).toContain(
      "To deactivate this listing, type its name &quot;Summer Camp &amp; Fun&quot; into the box below:",
    );
    expect(html).toContain(
      'name="confirm_identifier" placeholder="Summer Camp &amp; Fun" required',
    );
    expect(html).toContain('<button class="danger" type="submit">');
    expect(html).toContain("Deactivate Listing");
    expect(html).toContain("<title>Deactivate: Summer Camp &amp; Fun");
  });

  test("reactivate page explains the effect with a non-dangerous submit", () => {
    const html = adminReactivateListingPage(listing, OWNER_SESSION);

    expect(html).toContain('action="/admin/listing/7/reactivate"');
    expect(html).toContain(
      "<p>Reactivating this listing will make it available for registrations again.</p>",
    );
    expect(html).toContain(
      "<p>The public ticket page will be accessible and new attendees can register.</p>",
    );
    expect(html).toContain(
      "To reactivate this listing, type its name &quot;Summer Camp &amp; Fun&quot; into the box below:",
    );
    expect(html).toContain(
      'name="confirm_identifier" placeholder="Summer Camp &amp; Fun" required',
    );
    expect(html).not.toContain('<button class="danger" type="submit">');
    expect(html).toContain("/icons.svg#check");
    expect(html).toContain("Reactivate Listing");
    expect(html).toContain("<title>Reactivate: Summer Camp &amp; Fun");
  });
});
