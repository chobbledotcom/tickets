import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { logisticsAgents } from "#db/logistics-agents.ts";
import { settings } from "#db/settings.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
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
import { readTicketPage, setupCheckinTest } from "./helpers.ts";

describeWithEnv("check-in page role authorization", { db: true }, () => {
  describe("GET /checkin/:tokens (delivery agent session)", () => {
    test("delivery agents cannot use check-in tokens for another agent's booking", async () => {
      const assignedAgent = (
        await logisticsAgents.table.insert({ name: "Assigned van" })
      ).id;
      const otherAgent = (
        await logisticsAgents.table.insert({ name: "Other van" })
      ).id;
      const { cookie } = await createTestAgentSession({
        agentIds: [assignedAgent],
        token: "checkin-agent",
        username: "checkin-agent",
      });
      const own = await createTestAttendeeWithToken(
        "Assigned Person",
        "assigned@example.com",
        { usesLogistics: true },
      );
      const other = await createTestAttendeeWithToken(
        "Other Person",
        "other@example.com",
        { usesLogistics: true },
      );
      const today = testDate(todayInTz(settings.timezone));
      await assignBookingToAgent(
        own.attendee.id,
        own.listing.id,
        assignedAgent,
        today,
      );
      await assignBookingToAgent(
        other.attendee.id,
        other.listing.id,
        otherAgent,
        today,
      );

      const allowedBody = await readTicketPage(own.token, cookie);
      assertStringIncludes(allowedBody, "Assigned Person");
      // An agent's run-sheet view never carries the bulk actions: their
      // session is not a door role, so the POST would refuse them.
      assert(
        !allowedBody.includes('name="check_in"'),
        "the value should not contain the searched item",
      );
      assertStringIncludes(allowedBody, "assigned@example.com");
      assert(
        !allowedBody.includes("Check In All"),
        "the value should not contain the searched item",
      );
      assert(
        !allowedBody.includes(`href="/admin/attendees/${own.attendee.id}"`),
        "the value should not contain the searched item",
      );
      assert(
        !allowedBody.includes(`href="/admin/listing/${own.listing.id}"`),
        "the value should not contain the searched item",
      );
      assert(
        !allowedBody.includes(
          `/admin/listing/${own.listing.id}/attendee/${own.attendee.id}/checkin`,
        ),
        "the value should not contain the searched item",
      );

      const forbidden = await awaitTestRequest(`/checkin/${other.token}`, {
        cookie,
      });
      expect(forbidden.status).toBe(403);
      const forbiddenBody = await forbidden.text();
      assert(
        !forbiddenBody.includes("Other Person"),
        "the value should not contain the searched item",
      );
      assert(
        !forbiddenBody.includes("other@example.com"),
        "the value should not contain the searched item",
      );

      const mixed = await awaitTestRequest(
        `/checkin/${own.token}+${other.token}`,
        { cookie },
      );
      expect(mixed.status).toBe(200);
      const mixedBody = await mixed.text();
      assertStringIncludes(mixedBody, "Assigned Person");
      assertStringIncludes(mixedBody, "assigned@example.com");
      assert(
        !mixedBody.includes("Other Person"),
        "the value should not contain the searched item",
      );
      assert(
        !mixedBody.includes("other@example.com"),
        "the value should not contain the searched item",
      );
      assert(
        !mixedBody.includes(`href="/admin/attendees/${own.attendee.id}"`),
        "the value should not contain the searched item",
      );
      assert(
        !mixedBody.includes(`href="/admin/listing/${own.listing.id}"`),
        "the value should not contain the searched item",
      );
      assert(
        !mixedBody.includes(
          `/admin/listing/${own.listing.id}/attendee/${own.attendee.id}/checkin`,
        ),
        "the value should not contain the searched item",
      );
    });

    test("delivery agents see no bulk action on a fully refunded run-sheet leg", async () => {
      const { refundThroughLedger } = await import("#test-utils/ledger.ts");
      const assignedAgent = (
        await logisticsAgents.table.insert({ name: "Refunded van" })
      ).id;
      const { cookie } = await createTestAgentSession({
        agentIds: [assignedAgent],
        token: "checkin-agent-refunded",
        username: "checkin-agent-refunded",
      });
      const own = await createTestAttendeeWithToken(
        "Refunded Person",
        "refunded-agent@example.com",
        { usesLogistics: true },
      );
      await assignBookingToAgent(
        own.attendee.id,
        own.listing.id,
        assignedAgent,
        testDate(todayInTz(settings.timezone)),
      );
      await refundThroughLedger(own.attendee.id, own.listing.id);

      const body = await readTicketPage(own.token, cookie);
      assertStringIncludes(body, "Refunded Person");
      // A refunded leg offers nothing to change, and an agent's session is
      // not a door role: no bulk action may appear.
      assert(
        !body.includes("Check In All"),
        "the value should not contain the searched item",
      );
      assert(
        !body.includes('name="check_in"'),
        "the value should not contain the searched item",
      );
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
      assert(
        !body.includes("Check In All"),
        "the value should not contain the searched item",
      );
      assert(
        !body.includes("Check Out All"),
        "the value should not contain the searched item",
      );
      assert(
        !body.includes('name="check_in"'),
        "the value should not contain the searched item",
      );
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
      assert(
        !body.includes("perry@test.com"),
        "the value should not contain the searched item",
      );
      assert(
        !body.includes("<th>Email</th>"),
        "the value should not contain the searched item",
      );
      assert(
        !body.includes("<th>Phone</th>"),
        "the value should not contain the searched item",
      );
    });

    test("delivery agents see only the row whose leg is on their run sheet when one attendee has two rows on the same listing on different dates", async () => {
      // One attendee books the same listing twice on different dates, so both
      // rows share the (attendee, listing) pair. An agent who owns the leg on
      // only one date must not see the other row's date or quantity. Row A
      // is on the agent's run sheet today; row B is a future date with no
      // agent and must not appear.
      const assignedAgent = (
        await logisticsAgents.table.insert({ name: "Multi-row van" })
      ).id;
      const { cookie } = await createTestAgentSession({
        agentIds: [assignedAgent],
        token: "checkin-multirow",
        username: "checkin-multirow",
      });
      const today = testDate(todayInTz(settings.timezone));
      const laterDate = "2099-12-31";
      const { attendee, listing, token } = await createTestAttendeeWithToken(
        "Multi Row Person",
        "multirow@example.com",
        { usesLogistics: true },
        2,
      );
      // Row A (today, quantity 2): drop-off owned by `assignedAgent`.
      await assignBookingToAgent(attendee.id, listing.id, assignedAgent, today);
      // Row B (later date, quantity 3): no agent, never on the run sheet.
      await insertSecondBookingRow(attendee.id, listing.id, laterDate, 3);

      const body = await readTicketPage(token, cookie);

      // The agent owns only Row A, so only its quantity appears.
      assertStringIncludes(body, "Multi Row Person");
      assertStringIncludes(body, "multirow@example.com");
      // Row A's quantity (2) is visible; Row B's quantity (3) never is.
      assertStringIncludes(body, ">2<");
      assert(
        !body.includes(">3<"),
        "the value should not contain the searched item",
      );
      // Row A's date label is visible; Row B's later date must not leak.
      assertStringIncludes(body, formatDateLabel(today));
      assert(
        !body.includes(formatDateLabel(laterDate)),
        "the value should not contain the searched item",
      );
    });

    test("delivery agents see a leg that is on tomorrow's run sheet", async () => {
      const assignedAgent = (
        await logisticsAgents.table.insert({ name: "Tomorrow van" })
      ).id;
      const { cookie } = await createTestAgentSession({
        agentIds: [assignedAgent],
        token: "checkin-agent-tomorrow",
        username: "checkin-agent-tomorrow",
      });
      const tomorrow = addDays(testDate(todayInTz(settings.timezone)), 1);
      const { attendee, listing, token } = await createTestAttendeeWithToken(
        "Tomorrow Person",
        "tomorrow@example.com",
        { usesLogistics: true },
      );
      await assignBookingToAgent(
        attendee.id,
        listing.id,
        assignedAgent,
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

      const response = await awaitTestRequest(`/checkin/${token}`, { cookie });
      expect(response.status).toBe(403);
      const body = await response.text();
      assert(
        !body.includes("Editor Hidden"),
        "the value should not contain the searched item",
      );
      assert(
        !body.includes("editor-hidden@example.com"),
        "the value should not contain the searched item",
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

      assertStringIncludes(body, "Door Guest");
      assertStringIncludes(body, "Check In All");
      // The admin pages behind these links stay shut for a scanner login, so
      // the page must not promise them (never render a forbidden link).
      assert(
        !body.includes('href="/admin/attendees/'),
        "the value should not contain the searched item",
      );
      assert(
        !body.includes('href="/admin/listing/'),
        "the value should not contain the searched item",
      );
    });
  });
});
