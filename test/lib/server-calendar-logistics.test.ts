import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import { setLogisticsAssignments } from "#shared/db/logistics.ts";
import { logisticsAgentsTable } from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  awaitTestRequest,
  createDailyTestListing,
  describeWithEnv,
  getAttendeesRaw,
  submitTicketForm,
  testCookie,
} from "#test-utils";

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
      settings.setForTest({ has_logistics: true });
      const listing = await createDailyTestListing();
      const d = date();
      await submitTicketForm(listing.slug, {
        date: d,
        email: "a@test.com",
        name: "Agent User",
      });
      const assigned = await logisticsAgentsTable.insert({ name: "Mine" });
      const other = await logisticsAgentsTable.insert({ name: "Other" });
      const attendees = await getAttendeesRaw(listing.id);
      await setLogisticsAssignments(
        attendees[0]!.id,
        false,
        new Map([
          [listing.id, { endAgentId: null, startAgentId: assigned.id }],
        ]),
      );
      return { assigned, d, other };
    };

    test("renders the agent filter bar when agents exist", async () => {
      const { d } = await setup();
      const html = await calendarHtml(`/admin/calendar?date=${d}`);
      expect(html).toContain("Agent:");
      expect(html).toContain("Mine");
      expect(html).toContain("Agent User");
    });

    test("renders the agent filter bar even with no date selected", async () => {
      await setup();
      // With a non-default agent active and no date, the "All" link carries
      // neither a date nor an agent param.
      const html = await calendarHtml("/admin/calendar?agent=none");
      expect(html).toContain("Agent:");
      expect(html).toContain('href="/admin/calendar#attendees"');
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

    test("no filter bar when logistics is disabled", async () => {
      const { d } = await setup();
      settings.setForTest({ has_logistics: false });
      const html = await calendarHtml(`/admin/calendar?date=${d}`);
      expect(html).not.toContain("Agent:");
    });
  },
);
