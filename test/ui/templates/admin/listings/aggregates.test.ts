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
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

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
    expectIncludesAll(html, [
      "Recalculate: Workshop",
      "Current",
      "From attendee data",
      "Compare the stored listing totals",
      'class="table-scroll"',
      'name="recalculate_fields"',
      'value="booked_quantity"',
      ">9<",
      ">4<",
      // The recalculate page marks the Home nav entry (/admin/) active.
      '<a class="active" href="/admin/">',
    ]);
  });
});

describe("ListingAggregateMismatchNotice", () => {
  registerListingTemplateHooks();

  test("renders only the mismatched field with the error copy", () => {
    const html = ListingAggregateMismatchNotice({
      actionHref: "/admin/listings/recalculate/1",
      aggregateRecalculation: oneMismatch,
    })!.toString();

    expectIncludesAll(html, [
      "Listing running totals do not match attendee rows.",
      "Expected values come from attendee rows.",
      '<a href="/admin/listings/recalculate/1">Review and recalculate totals</a>',
      // booked_quantity drifted (expected 4, got 9); tickets_count matched.
      "<strong>Total attendees ever</strong>: expected <strong>4</strong>, got <strong>9</strong>",
    ]);
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

    expectIncludesAll(html, [
      "<th>Running total check</th>",
      "Listing running totals do not match attendee rows.",
      `/admin/listings/recalculate/${listing.id}`,
      "Review and recalculate totals",
      "<strong>Total attendees ever</strong>: expected <strong>4</strong>, got <strong>9</strong>",
    ]);
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
