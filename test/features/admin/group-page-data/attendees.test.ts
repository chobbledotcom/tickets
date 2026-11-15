import { assertStringIncludes } from "@std/assert";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { listingAggregates } from "#db/listings/aggregates.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  expectHtmlResponse,
  expectIncludesAll,
  expectStatus,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
import { adminGet } from "#test-utils/session.ts";
import type { Group, ListingWithCount } from "#types";

/** A group holding one listing, plus the attendees booked on it — the roster
 *  every assertion below reads. `listingFields` sets the per-test capacity,
 *  price, or quantity cap. */
const groupWithRoster = async (
  names: { group: string; listing: string; slug: string },
  roster: readonly (readonly [
    name: string,
    email: string,
    quantity?: number,
  ])[],
  listingFields: TestListingOverrides = {},
): Promise<{ group: Group; listing: ListingWithCount }> => {
  const group = await createTestGroup({ name: names.group, slug: names.slug });
  const listing = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    ...listingFields,
    name: names.listing,
  });
  for (const [name, email, quantity] of roster) {
    await createTestAttendee(listing.id, listing.slug, name, email, quantity);
  }
  return { group, listing };
};

describeWithEnv("server (admin groups) — attendee stats", { db: true }, () => {
  beforeEach(() => {
    setDemoModeForTest(false);
  });

  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("GET /admin/groups/:id — attendee stats", () => {
    test("shows attendee count and checked-in stats", async () => {
      const { group } = await groupWithRoster(
        { group: "Stats Group", listing: "Stats Listing", slug: "stats-group" },
        [
          ["Alice", "alice@test.com"],
          ["Bob", "bob@test.com"],
        ],
        { maxAttendees: 20 },
      );

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expectIncludesAll(html, ["Attendees", "Checked In", "0 / 2", "2 remain"]);
    });

    test("shows stored-total mismatches on the group detail page", async () => {
      const { group, listing } = await groupWithRoster(
        {
          group: "Mismatch Group",
          listing: "Mismatch Listing",
          slug: "mismatch-group",
        },
        [["Actual", "actual-group@test.com", 2]],
        { maxAttendees: 20, maxQuantity: 20 },
      );
      await listingAggregates.update(listing.id, {
        booked_quantity: 9,
        tickets_count: 1,
      });

      const response = await adminGet(`/admin/groups/${group.id}`);
      await expectHtmlResponse(
        response,
        200,
        "Running total check",
        "expected <strong>2</strong>, got",
        "Review group listings",
      );
    });

    test("shows dual checked-in rows when attendees have multi-quantity", async () => {
      const { group } = await groupWithRoster(
        {
          group: "Multi Qty Group",
          listing: "Multi Qty Listing",
          slug: "multi-qty-group",
        },
        [
          ["Alice", "alice@multi.com", 3],
          ["Bob", "bob@multi.com"],
        ],
        { maxAttendees: 20, maxQuantity: 5 },
      );

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expectIncludesAll(html, [
        "Attendees Checked In",
        "Tickets Checked In",
        // 0 / 2 tickets checked in, 0 / 4 attendees checked in
        "0 / 2",
        "0 / 4",
      ]);
    });

    test("shows attendees table with listing name column", async () => {
      const { group, listing } = await groupWithRoster(
        {
          group: "Table Group",
          listing: "Table Listing",
          slug: "table-group",
        },
        [["Charlie", "charlie@test.com"]],
      );

      // The roster now lives on the Attendees tab, not the Overview.
      const response = await adminGet(`/admin/groups/${group.id}/attendees`);
      expectStatus(200)(response);
      const html = await response.text();
      expectIncludesAll(html, [
        "Charlie",
        "Table Listing",
        `/admin/listing/${listing.id}`,
      ]);
    });

    test("Attendees tab renders the roster's answers column when a listing has questions", async () => {
      // A listing question makes the roster carry question data, so the
      // Attendees tab renders the Answers column (the questionData branch that
      // is absent for a question-free group).
      const { group, listing } = await groupWithRoster(
        {
          group: "Q Attendees",
          listing: "Q Attendee Listing",
          slug: "q-attendees",
        },
        [["Quentin", "quentin@test.com"]],
      );
      await createQuestionWithAnswer([listing.id]);

      const html = await (
        await adminGet(`/admin/groups/${group.id}/attendees`)
      ).text();
      expectIncludesAll(html, [
        "Quentin",
        // The Answers column only renders when the roster carries question data.
        "<th>Answers</th>",
      ]);
    });

    test("shows question answer summary in group details", async () => {
      const { group, listing } = await groupWithRoster(
        { group: "Q Group", listing: "Q Listing", slug: "q-group" },
        [["Dave", "dave@test.com"]],
      );
      await createQuestionWithAnswer([listing.id]);

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expectIncludesAll(html, ["<th>Choose one</th>", "Chosen (0)"]);
    });

    test("shows total revenue for paid listings", async () => {
      const { group } = await groupWithRoster(
        {
          group: "Revenue Group",
          listing: "Paid Listing",
          slug: "revenue-group",
        },
        [["Donor", "donor@test.com"]],
        { unitPrice: 1000 },
      );

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      assertStringIncludes(html, "Total income earned");
    });
  });
});
