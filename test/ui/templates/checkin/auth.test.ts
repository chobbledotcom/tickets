import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { logisticsAgents } from "#db/logistics-agents.ts";
import { settings } from "#db/settings.ts";
import { formatDateLabel } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import {
  assignBookingToAgent,
  insertSecondBookingRow,
} from "#test-utils/logistics.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
} from "#test-utils/session.ts";

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

      const allowed = await awaitTestRequest(`/checkin/${own.token}`, {
        cookie,
      });
      expect(allowed.status).toBe(200);
      const allowedBody = await allowed.text();
      expect(allowedBody).toContain("Assigned Person");
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

      const response = await awaitTestRequest(`/checkin/${token}`, { cookie });
      expect(response.status).toBe(200);
      const body = await response.text();

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
});
