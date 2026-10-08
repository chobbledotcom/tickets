import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { logisticsAgents } from "#db/logistics-agents.ts";
import { settings } from "#db/settings.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
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
      const today = todayInTz(settings.timezone);
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
      expect(allowedBody).toContain("Assigned Person");
      // An agent's run-sheet view never carries the bulk actions: their
      // session is not a door role, so the POST would refuse them.
      expect(allowedBody).not.toContain('name="check_in"');
      expect(allowedBody).toContain("assigned@example.com");
      expect(allowedBody).not.toContain("Check In All");
      expect(allowedBody).not.toContain(
        `href="/admin/attendees/${own.attendee.id}"`,
      );
      expect(allowedBody).not.toContain(
        `href="/admin/listing/${own.listing.id}"`,
      );
      expect(allowedBody).not.toContain(
        `/admin/listing/${own.listing.id}/attendee/${own.attendee.id}/checkin`,
      );

      const forbidden = await awaitTestRequest(`/checkin/${other.token}`, {
        cookie,
      });
      expect(forbidden.status).toBe(403);
      const forbiddenBody = await forbidden.text();
      expect(forbiddenBody).not.toContain("Other Person");
      expect(forbiddenBody).not.toContain("other@example.com");

      const mixed = await awaitTestRequest(
        `/checkin/${own.token}+${other.token}`,
        { cookie },
      );
      expect(mixed.status).toBe(200);
      const mixedBody = await mixed.text();
      expect(mixedBody).toContain("Assigned Person");
      expect(mixedBody).toContain("assigned@example.com");
      expect(mixedBody).not.toContain("Other Person");
      expect(mixedBody).not.toContain("other@example.com");
      expect(mixedBody).not.toContain(
        `href="/admin/attendees/${own.attendee.id}"`,
      );
      expect(mixedBody).not.toContain(
        `href="/admin/listing/${own.listing.id}"`,
      );
      expect(mixedBody).not.toContain(
        `/admin/listing/${own.listing.id}/attendee/${own.attendee.id}/checkin`,
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
        todayInTz(settings.timezone),
      );
      await refundThroughLedger(own.attendee.id, own.listing.id);

      const body = await readTicketPage(own.token, cookie);
      expect(body).toContain("Refunded Person");
      // A refunded leg offers nothing to change, and an agent's session is
      // not a door role: no bulk action may appear.
      expect(body).not.toContain("Check In All");
      expect(body).not.toContain('name="check_in"');
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
      expect(body).toContain("Still Home");
      expect(body).not.toContain("Check In All");
      expect(body).not.toContain("Check Out All");
      expect(body).not.toContain('name="check_in"');
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
      expect(body).toContain("<th>Name</th>");
      expect(body).not.toContain("perry@test.com");
      expect(body).not.toContain("<th>Email</th>");
      expect(body).not.toContain("<th>Phone</th>");
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
      const today = todayInTz(settings.timezone);
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
      expect(body).toContain("Multi Row Person");
      expect(body).toContain("multirow@example.com");
      // Row A's quantity (2) is visible; Row B's quantity (3) never is.
      expect(body).toContain(">2<");
      expect(body).not.toContain(">3<");
      // Row A's date label is visible; Row B's later date must not leak.
      expect(body).toContain(formatDateLabel(today));
      expect(body).not.toContain(formatDateLabel(laterDate));
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
      const tomorrow = addDays(todayInTz(settings.timezone), 1);
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
      expect(body).toContain("Tomorrow Person");
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
      expect(body).not.toContain("Editor Hidden");
      expect(body).not.toContain("editor-hidden@example.com");
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

      expect(body).toContain("Door Guest");
      expect(body).toContain("Check In All");
      // The admin pages behind these links stay shut for a scanner login, so
      // the page must not promise them (never render a forbidden link).
      expect(body).not.toContain('href="/admin/attendees/');
      expect(body).not.toContain('href="/admin/listing/');
    });
  });
});
