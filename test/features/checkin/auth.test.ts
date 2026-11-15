import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { DateString } from "#shared/validation/date-string.ts";
import { expectExcludesAll } from "#test-utils/assertions/absent.ts";
import { expectHtml, expectIncludesAll } from "#test-utils/assertions.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { makeVan } from "#test-utils/deliveries.ts";
import {
  assignBookingToAgent,
  insertSecondBookingRow,
} from "#test-utils/logistics.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
} from "#test-utils/session.ts";
import { withSetting } from "#test-utils/settings.ts";
import type { Attendee, Listing } from "#types";
import { readTicketPage, setupCheckinTest } from "./helpers.ts";

describeWithEnv("check-in page role authorization", { db: true }, () => {
  /** A delivery agent named `agent`, the session that reads the door page as
   *  them, and one logistics attendee whose booking that agent owns on
   *  `date` — the run-sheet fixture every delivery-agent test opens with. */
  const agentBooking = async (
    agent: string,
    person: { email: string; name: string; quantity?: number },
    date: DateString,
  ): Promise<{
    attendee: Attendee;
    cookie: string;
    listing: Listing;
    token: string;
  }> => {
    const agentId = await makeVan(agent);
    const { cookie } = await createTestAgentSession({
      agentIds: [agentId],
      token: agent,
      username: agent,
    });
    const booking = await createTestAttendeeWithToken(
      person.name,
      person.email,
      { usesLogistics: true },
      person.quantity ?? 1,
    );
    await assignBookingToAgent(
      booking.attendee.id,
      booking.listing.id,
      agentId,
      date,
    );
    return { ...booking, cookie };
  };

  describe("GET /checkin/:tokens (delivery agent session)", () => {
    test("delivery agents cannot use check-in tokens for another agent's booking", async () => {
      const today = testDate(todayInTz(settings.timezone));
      const own = await agentBooking(
        "Assigned van",
        { email: "assigned@example.com", name: "Assigned Person" },
        today,
      );
      const other = await agentBooking(
        "Other van",
        { email: "other@example.com", name: "Other Person" },
        today,
      );

      const allowedBody = await readTicketPage(own.token, own.cookie);
      assertStringIncludes(allowedBody, "Assigned Person");
      assertStringIncludes(allowedBody, "assigned@example.com");
      // An agent's run-sheet view never carries the bulk actions: their
      // session is not a door role, so the POST would refuse them.
      expectExcludesAll(allowedBody, [
        'name="check_in"',
        "Check In All",
        `href="/admin/attendees/${own.attendee.id}"`,
        `href="/admin/listing/${own.listing.id}"`,
        `/admin/listing/${own.listing.id}/attendee/${own.attendee.id}/checkin`,
      ]);

      const forbidden = await awaitTestRequest(`/checkin/${other.token}`, {
        cookie: own.cookie,
      });
      expect(forbidden.status).toBe(403);
      const forbiddenBody = await forbidden.text();
      expectExcludesAll(forbiddenBody, ["Other Person", "other@example.com"]);

      const mixed = await awaitTestRequest(
        `/checkin/${own.token}+${other.token}`,
        { cookie: own.cookie },
      );
      expect(mixed.status).toBe(200);
      const mixedBody = await mixed.text();
      expectIncludesAll(mixedBody, ["Assigned Person", "assigned@example.com"]);
      expectExcludesAll(mixedBody, [
        "Other Person",
        "other@example.com",
        `href="/admin/attendees/${own.attendee.id}"`,
        `href="/admin/listing/${own.listing.id}"`,
        `/admin/listing/${own.listing.id}/attendee/${own.attendee.id}/checkin`,
      ]);
    });

    test("delivery agents see no bulk action on a fully refunded run-sheet leg", async () => {
      const { refundThroughLedger } = await import("#test-utils/ledger.ts");
      const own = await agentBooking(
        "Refunded van",
        { email: "refunded-agent@example.com", name: "Refunded Person" },
        testDate(todayInTz(settings.timezone)),
      );
      await refundThroughLedger(own.attendee.id, own.listing.id);

      const body = await readTicketPage(own.token, own.cookie);
      assertStringIncludes(body, "Refunded Person");
      // A refunded leg offers nothing to change, and an agent's session is
      // not a door role: no bulk action may appear.
      expectExcludesAll(body, ["Check In All", 'name="check_in"']);
    });

    test("a scanner's door role alone offers no action on a token no row can change", async () => {
      const { refundThroughLedger } = await import("#test-utils/ledger.ts");
      const { attendee, token } = await createTestAttendeeWithToken(
        "Still Home",
        "still-home@test.com",
      );
      const scanner = await createTestScannerSession();
      await refundThroughLedger(attendee.id, attendee.listing_id);

      const body = await readTicketPage(token, scanner.cookie);
      // A door role is one half of the bulk action's gate; the other half is
      // a row the POST could change. A fully refunded token meets neither
      // offer: the POST would refuse, so the page must not advertise it.
      assertStringIncludes(body, "Still Home");
      expectExcludesAll(body, [
        "Check In All",
        "Check Out All",
        'name="check_in"',
      ]);
    });

    test("keeps the door-safe columns even when a staff layout names contact ones", async () => {
      const { token } = await setupCheckinTest("Perry", "perry@test.com");
      const scanner = await createTestScannerSession();

      const body = await withSetting(
        { attendee_column_order: "{{name}} {{email}} {{phone}}" },
        async () =>
          (
            await awaitTestRequest(`/checkin/${token}`, {
              cookie: scanner.cookie,
            })
          ).text(),
      );

      // An operator's saved column order is a staff-table choice; the
      // door-only ticket page always reads its own fixed door-safe columns,
      // so a contact column can never ride onto a door worker's screen.
      assertStringIncludes(body, "<th>Name</th>");
      expectExcludesAll(body, [
        "perry@test.com",
        "<th>Email</th>",
        "<th>Phone</th>",
      ]);
    });

    test("delivery agents see only the row whose leg is on their run sheet when one attendee has two rows on the same listing on different dates", async () => {
      // One attendee books the same listing twice on different dates, so both
      // rows share the (attendee, listing) pair. An agent who owns the leg on
      // only one date must not see the other row's date or quantity. Row A
      // is on the agent's run sheet today; row B is a future date with no
      // agent and must not appear.
      const today = testDate(todayInTz(settings.timezone));
      const laterDate = "2099-12-31";
      const { attendee, listing, token, cookie } = await agentBooking(
        "Multi-row van",
        {
          email: "multirow@example.com",
          name: "Multi Row Person",
          quantity: 2,
        },
        today,
      );
      // Row B (later date, quantity 3): no agent, never on the run sheet.
      await insertSecondBookingRow(attendee.id, listing.id, laterDate, 3);

      const body = await readTicketPage(token, cookie);

      // The agent owns only Row A, so only its quantity appears.
      expectIncludesAll(body, [
        "Multi Row Person",
        "multirow@example.com",
        // Row A's quantity (2) is visible; Row B's quantity (3) never is.
        ">2<",
      ]);
      // Row A's date label is visible; Row B's later date must not leak.
      assertStringIncludes(body, formatDateLabel(today));
      expectExcludesAll(body, [">3<", formatDateLabel(laterDate)]);
    });

    test("delivery agents see a leg that is on tomorrow's run sheet", async () => {
      const tomorrow = addDays(testDate(todayInTz(settings.timezone)), 1);
      const { token, cookie } = await agentBooking(
        "Tomorrow van",
        { email: "tomorrow@example.com", name: "Tomorrow Person" },
        tomorrow,
      );

      const body = await readTicketPage(token, cookie);
      assertStringIncludes(body, "Tomorrow Person");
    });
  });

  describe("GET /checkin/:tokens (editor session)", () => {
    test("editors cannot use check-in tokens to decrypt attendee details", async () => {
      const { cookie } = await createTestEditorSession({
        token: "checkin-editor",
        username: "checkin-editor",
      });
      const { token } = await createTestAttendeeWithToken(
        "Editor Hidden",
        "editor-hidden@example.com",
      );

      await expectHtml(
        await awaitTestRequest(`/checkin/${token}`, { cookie }),
        {
          notContains: ["Editor Hidden", "editor-hidden@example.com"],
          status: 403,
        },
      );
    });
  });

  describe("GET /checkin/:tokens (scanner session)", () => {
    test("shows a scanner login the attendee and the check-in toggle", async () => {
      const { token } = await createTestAttendeeWithToken(
        "Door Guest",
        "doorguest@example.com",
      );
      const { cookie } = await createTestScannerSession({
        token: "checkin-scanner",
      });

      const body = await readTicketPage(token, cookie);

      expectIncludesAll(body, ["Door Guest", "Check In All"]);
      // The admin pages behind these links stay shut for a scanner login, so
      // the page must not promise them (never render a forbidden link).
      expectExcludesAll(body, [
        'href="/admin/attendees/',
        'href="/admin/listing/',
      ]);
    });
  });
});
