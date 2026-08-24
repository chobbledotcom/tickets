import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingsTable } from "#db/listings/records.ts";
import { setLogisticsAssignments } from "#db/logistics.ts";
import { logisticsAgents } from "#db/logistics-agents.ts";
import { settings } from "#db/settings.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { getAttendeesRaw } from "#test-utils/db-helpers/attendees.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { testCookie } from "#test-utils/session.ts";
import { featureSetting } from "#test-utils/settings.ts";

const date = () => addDays(todayInTz("UTC"), 1);

const calendarHtml = async (query: string): Promise<string> => {
  const response = await awaitTestRequest(query, {
    cookie: await testCookie(),
  });
  return response.text();
};

describeWithEnv(
  "admin calendar logistics filter",
  { db: true, env: { NTFY_URL: undefined } },
  () => {
    const setup = async () => {
      settings.setForTest(featureSetting("logistics"));
      const listing = await createDailyTestListing();
      await listingsTable.update(listing.id, { usesLogistics: true });
      const d = date();
      await submitTicketForm(listing.slug, {
        date: d,
        email: "a@test.com",
        name: "Agent User",
      });
      const assigned = await logisticsAgents.table.insert({ name: "Mine" });
      const other = await logisticsAgents.table.insert({ name: "Other" });
      const attendees = await getAttendeesRaw(listing.id);
      await setLogisticsAssignments(
        attendees[0]!.id,
        false,
        new Map([
          [
            listing.id,
            {
              endAgentId: null,
              endTime: "",
              startAgentId: assigned.id,
              startTime: "",
            },
          ],
        ]),
      );
      return { assigned, d, listing, other };
    };

    const exportCsv = async (query: string): Promise<string> => {
      const response = await awaitTestRequest(query, {
        cookie: await testCookie(),
      });
      return response.text();
    };

    test("CSV export includes the run-sheet agent columns", async () => {
      const { d } = await setup();
      const csv = await exportCsv(`/admin/calendar/export?date=${d}`);
      expect(csv).toContain("Start Agent,Start Time,End Agent,End Time");
      expect(csv).toContain("Mine");
      expect(csv).toContain("Agent User");
    });

    test("CSV export honours the agent filter", async () => {
      const { d, other } = await setup();
      const csv = await exportCsv(
        `/admin/calendar/export?date=${d}&agent=${other.id}`,
      );
      // Filtered to the other agent → the booking drops out entirely.
      expect(csv).not.toContain("Agent User");
    });

    test("renders the agent filter bar when agents exist", async () => {
      const { d } = await setup();
      const html = await calendarHtml(`/admin/calendar?date=${d}`);
      expect(html).toContain("Agent:");
      expect(html).toContain("Mine");
      expect(html).toContain("Agent User");
    });

    test("does not load the agent filter bar until a date is selected", async () => {
      await setup();
      const html = await calendarHtml("/admin/calendar?agent=none");
      expect(html).not.toContain("Agent:");
      expect(html).not.toContain("SELECT * FROM logistics_agents");
      expect(html).toContain('href="/admin/deliveries"');
    });

    test("filtering to the assigned agent keeps the attendee", async () => {
      const { d, assigned } = await setup();
      const html = await calendarHtml(
        `/admin/calendar?date=${d}&agent=${assigned.id}`,
      );
      expect(html).toContain("Agent User");
    });

    test("filtering to another agent hides the attendee", async () => {
      const { d, other } = await setup();
      const html = await calendarHtml(
        `/admin/calendar?date=${d}&agent=${other.id}`,
      );
      expect(html).not.toContain("Agent User");
    });

    test("the 'none' filter hides assigned attendees", async () => {
      const { d } = await setup();
      const html = await calendarHtml(`/admin/calendar?date=${d}&agent=none`);
      expect(html).not.toContain("Agent User");
    });

    test("keeps the chosen agent in the links that change the day", async () => {
      const { d, assigned } = await setup();
      const html = await calendarHtml(
        `/admin/calendar?date=${d}&agent=${assigned.id}`,
      );
      const withAgent = `/admin/calendar?date=${d}&amp;agent=${assigned.id}`;

      // Picking another day, stepping a month, and the address an attendee
      // page returns by all carried only the date. The operator landed on the
      // whole site's list for that day with nothing to say the run sheet had
      // gone.
      expect(html).toContain(`href="${withAgent}#attendees"`);
      expect(html).toContain(`value="${withAgent}#attendees"`);
      expect(html).toContain(`${withAgent}&amp;cal=`);
    });

    test("keeps the agent out of the link that shows every agent", async () => {
      const { d, assigned } = await setup();
      const html = await calendarHtml(
        `/admin/calendar?date=${d}&agent=${assigned.id}`,
      );
      expect(html).toContain(`href="/admin/calendar?date=${d}#attendees"`);
    });

    test("clears the agent with the date, since its bar goes too", async () => {
      const { d, assigned } = await setup();
      const html = await calendarHtml(
        `/admin/calendar?date=${d}&agent=${assigned.id}`,
      );
      expect(html).toContain('value="/admin/calendar#attendees"');
    });

    test("no filter bar when logistics is disabled", async () => {
      const { d } = await setup();
      settings.setForTest(featureSetting());
      const html = await calendarHtml(`/admin/calendar?date=${d}`);
      expect(html).not.toContain("Agent:");
    });
  },
);
