import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { updateListingAggregateValues } from "#shared/db/listings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import { expectHtmlResponse, expectStatus } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv("server (admin groups) — attendee stats", { db: true }, () => {
  beforeEach(() => {
    setDemoModeForTest(false);
  });

  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("GET /admin/groups/:id — attendee stats", () => {
    test("shows attendee count and checked-in stats", async () => {
      const group = await createTestGroup({
        name: "Stats Group",
        slug: "stats-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 20,
        name: "Stats Listing",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "alice@test.com",
      );
      await createTestAttendee(listing.id, listing.slug, "Bob", "bob@test.com");

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Attendees");
      expect(html).toContain("Checked In");
      expect(html).toContain("0 / 2");
      expect(html).toContain("2 remain");
    });

    test("shows stored-total mismatches on the group detail page", async () => {
      const group = await createTestGroup({
        name: "Mismatch Group",
        slug: "mismatch-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 20,
        name: "Mismatch Listing",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Actual",
        "actual-group@test.com",
        2,
      );
      await updateListingAggregateValues(listing.id, {
        booked_quantity: 9,
        tickets_count: 1,
      });

      const response = await adminGet(`/admin/groups/${group.id}`);
      await expectHtmlResponse(
        response,
        200,
        "Running total check",
        "expected <strong>1</strong>, got",
        "Review group listings",
      );
    });

    test("shows dual checked-in rows when attendees have multi-quantity", async () => {
      const group = await createTestGroup({
        name: "Multi Qty Group",
        slug: "multi-qty-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 20,
        maxQuantity: 5,
        name: "Multi Qty Listing",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "alice@multi.com",
        3,
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Bob",
        "bob@multi.com",
      );

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Attendees Checked In");
      expect(html).toContain("Tickets Checked In");
      // 0 / 2 tickets checked in, 0 / 4 attendees checked in
      expect(html).toContain("0 / 2");
      expect(html).toContain("0 / 4");
    });

    test("shows attendees table with listing name column", async () => {
      const group = await createTestGroup({
        name: "Table Group",
        slug: "table-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Table Listing",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Charlie",
        "charlie@test.com",
      );

      // The roster now lives on the Attendees tab, not the Overview.
      const response = await adminGet(`/admin/groups/${group.id}/attendees`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Charlie");
      expect(html).toContain("Table Listing");
      expect(html).toContain(`/admin/listing/${listing.id}`);
    });

    test("Attendees tab renders the roster's answers column when a listing has questions", async () => {
      // A listing question makes the roster carry question data, so the
      // Attendees tab renders the Answers column (the questionData branch that
      // is absent for a question-free group).
      const group = await createTestGroup({
        name: "Q Attendees",
        slug: "q-attendees",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Q Attendee Listing",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Quentin",
        "quentin@test.com",
      );
      const { questionsTable, answersTable } = await import(
        "#shared/db/questions/tables.ts"
      );
      const { setListingQuestions } = await import(
        "#shared/db/questions/queries.ts"
      );
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Meal choice",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Veg",
      });
      await setListingQuestions(listing.id, [q.id]);

      const html = await (
        await adminGet(`/admin/groups/${group.id}/attendees`)
      ).text();
      expect(html).toContain("Quentin");
      // The Answers column only renders when the roster carries question data.
      expect(html).toContain("<th>Answers</th>");
    });

    test("shows question answer summary in group details", async () => {
      const group = await createTestGroup({
        name: "Q Group",
        slug: "q-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Q Listing",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Dave",
        "dave@test.com",
      );
      const { questionsTable, answersTable } = await import(
        "#shared/db/questions/tables.ts"
      );
      const { setListingQuestions } = await import(
        "#shared/db/questions/queries.ts"
      );
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Color",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Red",
      });
      await setListingQuestions(listing.id, [q.id]);

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("<th>Color</th>");
      expect(html).toContain("Red (0)");
    });

    test("shows total revenue for paid listings", async () => {
      const group = await createTestGroup({
        name: "Revenue Group",
        slug: "revenue-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Paid Listing",
        unitPrice: 1000,
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Donor",
        "donor@test.com",
      );

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Total Revenue");
    });
  });
});
