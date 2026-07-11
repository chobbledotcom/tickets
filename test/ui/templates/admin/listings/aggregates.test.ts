import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { adminListingRecalculatePage } from "#templates/admin/listings/aggregates.tsx";
import {
  registerListingTemplateHooks,
  TEST_SESSION,
} from "#test/templates/admin/listings/helpers.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

registerListingTemplateHooks();

describe("adminListingRecalculatePage", () => {
  test("shows current and attendee-derived totals with checkboxes", () => {
    const listing = testListingWithCount({ name: "Workshop" });
    const html = adminListingRecalculatePage(
      listing,
      {
        booked_quantity: { current: 9, recalculated: 4 },
        tickets_count: { current: 5, recalculated: 2 },
      },
      TEST_SESSION,
    );
    expect(html).toContain("Recalculate: Workshop");
    expect(html).toContain("Current");
    expect(html).toContain("From attendee data");
    expect(html).toContain("Compare the stored listing totals");
    expect(html).toContain('class="table-scroll"');
    expect(html).toContain('name="recalculate_fields"');
    expect(html).toContain('value="booked_quantity"');
    expect(html).toContain(">9<");
    expect(html).toContain(">4<");
  });
});
