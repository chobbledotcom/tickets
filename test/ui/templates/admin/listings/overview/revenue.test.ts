import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import {
  detailHtml,
  registerListingTemplateHooks,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

describe("adminListingPage total revenue", () => {
  registerListingTemplateHooks();

  test("shows total revenue for paid listings", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 2, unit_price: 1000 }),
      {
        attendees: [
          testAttendee({ payment_id: "pi_test_1", price_paid: "1000" }),
          testAttendee({ id: 2, payment_id: "pi_test_2", price_paid: "2000" }),
        ],
      },
    );
    says(html, "Total Revenue");
    says(html, "£30");
  });

  test("does not show total revenue for free listings", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 1, unit_price: 0 }),
      { attendees: [testAttendee()] },
    );
    assert(!html.includes("Total Revenue"));
  });

  test("shows zero revenue for paid listing with no attendees", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 0, unit_price: 1000 }),
    );
    says(html, "Total Revenue");
    says(html, "£0");
  });
});
