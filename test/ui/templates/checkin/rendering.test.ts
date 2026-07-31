import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatDateLabel } from "#shared/dates.ts";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import { tableRowContaining } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createDailyTestAttendee,
  createMultiBookingAttendee,
  createTestAttendeeWithToken,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  assignBookingToAgent,
  insertSecondBookingRow,
} from "#test-utils/logistics.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminGet,
  createTestAgentSession,
  createTestEditorSession,
  testCookie,
} from "#test-utils/session.ts";
import { setupCheckinTest } from "./helpers.ts";

describeWithEnv("check-in page (GET /checkin/:tokens)", { db: true }, () => {
  describe("GET /checkin/:tokens (unauthenticated)", () => {
    test("shows public check-in message for unauthenticated users", async () => {
      const { token } = await createTestAttendeeWithToken(
        "Alice",
        "alice@test.com",
      );

      const response = await awaitTestRequest(`/checkin/${token}`);
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain("Check-in");
      expect(body).toContain("show this QR code");
    });

    test("returns 404 for invalid token", async () => {
      const response = await awaitTestRequest("/checkin/bad-token");
      expect(response.status).toBe(404);
    });
  });
  describe("GET /checkin/:tokens (authenticated admin)", () => {
    test("shows current status without auto-checking-in", async () => {
      const { token, session } = await setupCheckinTest("Bob", "bob@test.com");
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain("Check in");
      expect(body).toContain("Check In All");
      expect(body).not.toContain('class="success"');
    });

    test("keeps one row per booking line, each with its own listing's check-in button", async () => {
      const first = await createTestListing({
        maxAttendees: 10,
        name: "First Listing",
      });
      const second = await createTestListing({
        maxAttendees: 10,
        name: "Second Listing",
      });
      const attendee = await createMultiBookingAttendee(
        "Multi",
        "multi@test.com",
        [{ listingId: first.id }, { listingId: second.id }],
      );
      const cookie = await testCookie();

      const response = await awaitTestRequest(
        `/checkin/${attendee.ticket_token}`,
        { cookie },
      );
      const body = await response.text();
      // The bookings stay separate rows so each listing checks in on its own.
      expect(body).toContain(
        `/admin/listing/${first.id}/attendee/${attendee.id}/checkin`,
      );
      expect(body).toContain(
        `/admin/listing/${second.id}/attendee/${attendee.id}/checkin`,
      );
    });

    test("shows attendee contact details in admin view", async () => {
      const { token, session } = await setupCheckinTest(
        "Bob",
        "bob@test.com",
        { fields: "email,phone" },
        1,
        "555-1234",
      );
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain("Bob");
      expect(body).toContain("bob@test.com");
      expect(body).toContain("555-1234");
    });

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
      // Multi-row regression (Codex review on PR #1995): when one attendee
      // books the same listing twice on different dates, the (attendee,
      // listing) pair is shared by both rows. An agent who owns the leg on
      // only one date must not see the other row's date or quantity — that
      // would leak an unrelated booking the agent has no operational reason
      // to view. Row A is on the agent's run sheet today; row B is a future
      // date with no agent and must not appear.
      const assignedAgent = (
        await logisticsAgents.table.insert({ name: "Multi-row van" })
      ).id;
      const { cookie } = await createTestAgentSession({
        agentIds: [assignedAgent],
        token: "checkin-multiirow",
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
      // First row (today, quantity 2): drop-off owned by `assignedAgent`.
      await assignBookingToAgent(attendee.id, listing.id, assignedAgent, today);
      // Second row (later date, quantity 3): no agent, never on the run sheet.
      await insertSecondBookingRow(attendee.id, listing.id, laterDate, 3);

      const response = await awaitTestRequest(`/checkin/${token}`, { cookie });
      expect(response.status).toBe(200);
      const body = await response.text();

      // The agent owns only row A, so only its quantity should appear.
      expect(body).toContain("Multi Row Person");
      expect(body).toContain("multirow@example.com");
      // Row A's quantity (2) is visible; row B's quantity (3) must never be.
      expect(body).toContain(">2<");
      expect(body).not.toContain(">3<");
      // Row A's date label is visible; row B's later date must not leak.
      expect(body).toContain(formatDateLabel(today));
      expect(body).not.toContain(formatDateLabel(laterDate));
    });

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

    test("shows multiple attendees from different listings", async () => {
      const { listing: listingA, token: tokenA } =
        await createTestAttendeeWithToken("Carol", "carol@test.com");
      const { listing: listingB, token: tokenB } =
        await createTestAttendeeWithToken("Carol", "carol@test.com");

      const response = await adminGet(`/checkin/${tokenA}+${tokenB}`);
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain(listingA.name);
      expect(body).toContain(listingB.name);
    });

    test("returns 404 for invalid tokens when authenticated", async () => {
      const response = await adminGet("/checkin/bad-token");
      expect(response.status).toBe(404);
    });

    test("returns 404 for orphaned attendee with no listing links", async () => {
      const { listing, token } = await setupCheckinTest(
        "Orphan",
        "orphan@test.com",
      );
      const { getDb } = await import("#shared/db/client.ts");
      await getDb().execute({
        args: [listing.id],
        sql: "DELETE FROM listing_attendees WHERE listing_id = ?",
      });
      const response = await adminGet(`/checkin/${token}`);
      expect(response.status).toBe(404);
    });

    test("shows listing name and quantity in admin view", async () => {
      const { listing, token, session } = await setupCheckinTest(
        "Dave",
        "dave@test.com",
        { maxQuantity: 5 },
        3,
      );
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain(listing.name);
      expect(body).toContain("3");
    });

    test("links listing name to admin listing page", async () => {
      const { listing, token, session } = await setupCheckinTest(
        "Fay",
        "fay@test.com",
      );
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain(`href="/admin/listing/${listing.id}"`);
    });

    test("shows green bulk check-in button when not checked in", async () => {
      const { token, session } = await setupCheckinTest("Eve", "eve@test.com");
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain('class="bulk-checkin"');
      expect(body).toContain("Check In All");
      expect(body).toContain('value="true"');
    });

    test("displays booked date for daily listing in admin view", async () => {
      const date = "2026-02-15";
      const { token } = await createDailyTestAttendee(
        "Zara",
        "zara@test.com",
        date,
      );

      const response = await adminGet(`/checkin/${token}`);
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain(formatDateLabel(date));
      expect(body).toContain("<th>Date</th>");
    });

    test("shows the Date column when a daily listing attendee is combined with a standard one", async () => {
      const date = "2026-02-15";
      const { token: tokenA } = await createDailyTestAttendee(
        "Zara",
        "zara@test.com",
        date,
      );
      const { token: tokenB } = await createTestAttendeeWithToken(
        "Alice",
        "alice@test.com",
      );

      const response = await adminGet(`/checkin/${tokenA}+${tokenB}`);
      const body = await response.text();
      // The column header renders because at least one attendee in the bundle
      // has a date. Zara's row shows the formatted date label; Alice's row
      // shows an empty cell instead. The negative case — column hidden when
      // no attendee has a date — is covered by the test below.
      expect(body).toContain("<th>Date</th>");
      expect(tableRowContaining(body, "Zara")).toContain(formatDateLabel(date));
      expect(tableRowContaining(body, "Alice")).not.toContain(
        formatDateLabel(date),
      );
    });

    test("renders an empty cell for an attendee with no email when another attendee has one", async () => {
      // The email and phone columns only render when at least one attendee
      // in the bundle has the field. Mix one attendee with contact details
      // and one without so the columns render, then check each attendee's own
      // row for the right cell values.
      const listing = await createTestListing({ maxAttendees: 10 });
      const withContact = await bookAttendee(listing, {
        email: "with@test.com",
        name: "WithContact",
        phone: "0712345678",
      });
      if (!withContact.success) throw new Error("Failed to create attendee");
      const withoutContact = await bookAttendee(listing, {
        email: "",
        name: "NoContact",
      });
      if (!withoutContact.success) throw new Error("Failed to create attendee");

      const response = await adminGet(
        `/checkin/${withContact.attendees[0]!.ticket_token}+${withoutContact.attendees[0]!.ticket_token}`,
      );
      const body = await response.text();
      // Column headers render because at least one attendee has each field.
      expect(body).toContain("<th>Email</th>");
      expect(body).toContain("<th>Phone</th>");
      expect(tableRowContaining(body, "WithContact")).toContain(
        '<td>with@test.com</td><td><a href="tel:+44712345678">0712345678</a></td>',
      );
      expect(tableRowContaining(body, "NoContact")).toContain(
        "<td></td><td></td>",
      );
    });

    test("does not show date column for standard listing in admin view", async () => {
      const { token, session } = await setupCheckinTest(
        "Alice",
        "alice@test.com",
      );
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).not.toContain("<th>Date</th>");
    });
  });
});
