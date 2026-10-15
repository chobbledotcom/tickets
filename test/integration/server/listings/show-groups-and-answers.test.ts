// jscpd:ignore-start

import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { saveAttendeeAnswers } from "#db/questions/attendee-answers/save.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminGet, setupListingAndLogin } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv(
  "server listings > show groups and answers",
  { db: true },
  () => {
    describe("GET /admin/listing/:id", () => {
      /** Books an attendee onto `listing` and gives them a single "Size:
       *  Small" answer — the shared fixture behind the roster and Overview
       *  answer-rendering checks below. */
      const createAttendeeWithSizeAnswer = async (listing: {
        id: number;
        slug: string;
      }) => {
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Ada Lovelace",
          "ada@example.com",
        );
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "Size",
        });
        const small = await answersTable.insert({
          questionId: q.id,
          sortOrder: 0,
          text: "Small",
        });
        await listingQuestions.setIds(listing.id, [q.id]);
        await saveAttendeeAnswers(new Map([[attendee.id, [small.id]]]));
        return attendee;
      };

      test("shows Group Attendees row when listing is in a capped group", async () => {
        const { listing, cookie } = await setupListingAndLogin({
          maxAttendees: 100,
        });
        const group = await createTestGroup({
          maxAttendees: 20,
          name: "Capped Group",
          slug: "capped-grp",
        });
        await assignListingsToGroup([listing.id], group.id);
        // Sibling listing in the same group with bookings: proves the row's
        // count is the group-wide total, not just the current listing's.
        const sibling = await createTestListing({
          groupId: group.id,
          maxAttendees: 100,
          name: "Sibling",
        });
        await bookAttendee(sibling, {
          email: "a@test.com",
          name: "A",
          quantity: 4,
        });

        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}`,
          {
            cookie,
          },
        );
        const html = await response.text();
        assertStringIncludes(html, "Group Attendees");
        assertStringIncludes(html, "4 / 20");
        assertStringIncludes(html, "16 remain");
        assertStringIncludes(html, `href="/admin/groups/${group.id}"`);
      });

      test("shows the tightest capped group when a listing is in several", async () => {
        const { listing, cookie } = await setupListingAndLogin({
          maxAttendees: 100,
        });
        const loose = await createTestGroup({
          maxAttendees: 50,
          name: "Loose",
          slug: "loose-grp",
        });
        const tight = await createTestGroup({
          maxAttendees: 6,
          name: "Tight",
          slug: "tight-grp",
        });
        const looser = await createTestGroup({
          maxAttendees: 100,
          name: "Looser",
          slug: "looser-grp",
        });
        await assignListingsToGroup([listing.id], loose.id);
        await assignListingsToGroup([listing.id], tight.id);
        await assignListingsToGroup([listing.id], looser.id);
        // A sibling booked into the tight group makes it the binding constraint.
        const sibling = await createTestListing({
          groupId: tight.id,
          maxAttendees: 100,
          name: "Tight Sibling",
        });
        await bookAttendee(sibling, {
          email: "t@test.com",
          name: "T",
          quantity: 4,
        });

        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}`,
          {
            cookie,
          },
        );
        const html = await response.text();
        // The tight group (6 cap, 4 booked → 2 remain) is the binding one shown,
        // not the roomier groups it also belongs to.
        assertStringIncludes(html, "4 / 6");
        assertStringIncludes(html, "2 remain");
        assertStringIncludes(html, `href="/admin/groups/${tight.id}"`);
        assert(
          !html.includes(`href="/admin/groups/${loose.id}"`),
          "the value should not contain the searched item",
        );
        assert(
          !html.includes(`href="/admin/groups/${looser.id}"`),
          "the value should not contain the searched item",
        );
      });

      test("omits Group Attendees row when group is uncapped", async () => {
        const { listing, cookie } = await setupListingAndLogin({
          maxAttendees: 100,
        });
        const group = await createTestGroup({
          name: "Uncapped",
          slug: "uncapped-grp",
        });
        await assignListingsToGroup([listing.id], group.id);

        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}`,
          {
            cookie,
          },
        );
        const html = await response.text();
        assert(
          !html.includes("Group Attendees"),
          "the value should not contain the searched item",
        );
      });
      test("shows attendee answers in the roster when questions assigned", async () => {
        const { listing, cookie } = await setupListingAndLogin({
          maxAttendees: 100,
          name: "Q Listing",
        });
        // Create the attendee before assigning the question so the public form
        // doesn't require an answer, then record the answer directly.
        await createAttendeeWithSizeAnswer(listing);

        // The question answers now surface per-attendee in the Attendees tab's
        // roster (an "Answers" column) rather than an aggregate detail row.
        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}/attendees`,
          { cookie },
        );
        const html = await response.text();
        assertStringIncludes(html, "<th>Answers</th>");
        assertStringIncludes(html, '<span title="Size: Small">Small</span>');
      });

      test("shows the whole-listing answer aggregate on the Overview tab", async () => {
        const { listing, cookie } = await setupListingAndLogin({
          maxAttendees: 100,
          name: "Overview Answers Listing",
        });
        await createAttendeeWithSizeAnswer(listing);

        // The Overview details table carries the aggregate answer-count row for
        // the whole listing (distinct from the roster's per-attendee answers).
        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}`,
          {
            cookie,
          },
        );
        const html = await response.text();
        assertStringIncludes(html, "Size");
        assertStringIncludes(html, "Small (1)");
      });
      test("shows the Group Attendees row on the roster's per-date capacity for a daily listing in a capped group", async () => {
        const bookingDate = addDays(testDate(todayInTz("UTC")), 1);
        const group = await createTestGroup({
          maxAttendees: 20,
          name: "Daily Capped Group",
          slug: "daily-capped",
        });
        const listing = await createTestListing({
          bookableDays: [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
          ],
          groupId: group.id,
          listingType: "daily",
          maxAttendees: 100,
          maximumDaysAfter: 14,
          minimumDaysBefore: 0,
        });
        await submitTicketForm(listing.slug, {
          date: bookingDate,
          email: "ada@example.com",
          name: "Ada Lovelace",
        });

        // The per-date capacity table on the Attendees tab surfaces the group cap
        // row only for a daily listing viewed with a date filter.
        const response = await adminGet(
          `/admin/listing/${listing.id}/attendees?date=${bookingDate}`,
        );
        const html = await response.text();
        assertStringIncludes(html, "Group Attendees");
        assertStringIncludes(html, `href="/admin/groups/${group.id}"`);
        // The selected day keeps its checked-in summary (the combined page's
        // date-filtered shared rows), not just the capacity snippet.
        assertStringIncludes(html, "Checked In");
      });
    });
  },
);
