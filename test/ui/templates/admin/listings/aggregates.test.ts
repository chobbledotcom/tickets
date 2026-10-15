import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  adminListingRecalculatePage,
  ListingAggregateMismatchNotice,
  ListingAggregateMismatchRow,
} from "#templates/admin/listings/aggregates.tsx";
import { registerListingTemplateHooks } from "#test/ui/templates/admin/listings/helpers.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

/** booked_quantity mismatches (9 vs 4), tickets_count matches (5 vs 5). */
const oneMismatch = {
  booked_quantity: { current: 9, recalculated: 4 },
  tickets_count: { current: 5, recalculated: 5 },
};

describe("adminListingRecalculatePage", () => {
  registerListingTemplateHooks();

  test("shows current and attendee-derived totals with checkboxes", () => {
    const listing = testListingWithCount({ name: "Workshop" });
    const html = adminListingRecalculatePage(
      listing,
      {
        booked_quantity: { current: 9, recalculated: 4 },
        tickets_count: { current: 5, recalculated: 2 },
      },
      OWNER_SESSION,
    );
    says(html, "Recalculate: Workshop");
    says(html, "Current");
    says(html, "From attendee data");
    says(html, "Compare the stored listing totals");
    says(html, 'class="table-scroll"');
    says(html, 'name="recalculate_fields"');
    says(html, 'value="booked_quantity"');
    says(html, ">9<");
    says(html, ">4<");
    // The recalculate page marks the Home nav entry (/admin/) active.
    says(html, '<a class="active" href="/admin/">');
  });
});

describe("ListingAggregateMismatchNotice", () => {
  registerListingTemplateHooks();

  test("renders only the mismatched field with the error copy", () => {
    const html = ListingAggregateMismatchNotice({
      actionHref: "/admin/listings/recalculate/1",
      aggregateRecalculation: oneMismatch,
    })!.toString();

    says(html, "Listing running totals do not match attendee rows.");
    says(html, "Expected values come from attendee rows.");
    says(
      html,
      '<a href="/admin/listings/recalculate/1">Review and recalculate totals</a>',
    );
    // booked_quantity drifted (expected 4, got 9); tickets_count matched.
    says(
      html,
      "<strong>Total attendees ever</strong>: expected <strong>4</strong>, got <strong>9</strong>",
    );
    assert(!html.includes("Total ticket records"));
  });

  test("renders no notice when there is no recalculation", () => {
    const html = String(
      ListingAggregateMismatchNotice({
        actionHref: "/x",
        aggregateRecalculation: undefined,
      }),
    );
    assert(!html.includes("Listing running totals do not match"));
  });

  test("renders no notice when every stored total already matches", () => {
    const html = String(
      ListingAggregateMismatchNotice({
        actionHref: "/x",
        aggregateRecalculation: {
          booked_quantity: { current: 3, recalculated: 3 },
          tickets_count: { current: 2, recalculated: 2 },
        },
      }),
    );
    assert(!html.includes("Listing running totals do not match"));
  });
});

describe("ListingAggregateMismatchRow", () => {
  registerListingTemplateHooks();

  const listing = testListingWithCount({ name: "Workshop" });

  test("wraps the mismatch notice in a labelled table row", () => {
    const html = ListingAggregateMismatchRow({
      aggregateRecalculation: oneMismatch,
      listing,
    })!.toString();

    says(html, "<th>Running total check</th>");
    says(html, "Listing running totals do not match attendee rows.");
    says(html, `/admin/listings/recalculate/${listing.id}`);
    says(html, "Review and recalculate totals");
    says(
      html,
      "<strong>Total attendees ever</strong>: expected <strong>4</strong>, got <strong>9</strong>",
    );
  });

  test("is null when there is no mismatch", () => {
    expect(
      ListingAggregateMismatchRow({
        aggregateRecalculation: undefined,
        listing,
      }),
    ).toBeNull();
  });
});
