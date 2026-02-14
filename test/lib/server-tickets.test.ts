import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { formatDateLabel } from "#lib/dates.ts";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import {
  awaitTestRequest,
  createDailyTestEvent,
  createTestAttendee,
  createTestAttendeeWithToken,
  createTestDbWithSetup,
  createTestEvent,
  getAttendeesRaw,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

describe("ticket view (/t/:tokens)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  test("displays ticket for a single valid token", async () => {
    const { event, token } = await createTestAttendeeWithToken("Alice", "alice@test.com");

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(event.name);
    expect(body).toContain("Your Tickets");
  });

  test("displays tickets for multiple valid tokens", async () => {
    const { event: eventA, token: tokenA } = await createTestAttendeeWithToken("Bob", "bob@test.com");
    const eventB = await createTestEvent({ maxAttendees: 10 });
    await createTestAttendee(eventB.id, eventB.slug, "Bob", "bob@test.com", 2);
    const attendeesB = await getAttendeesRaw(eventB.id);
    const tokenB = attendeesB[0]!.ticket_token;

    const response = await awaitTestRequest(`/t/${tokenA}+${tokenB}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(eventA.name);
    expect(body).toContain(eventB.name);
  });

  test("returns 404 for invalid token", async () => {
    const response = await awaitTestRequest("/t/nonexistent-token");
    expect(response.status).toBe(404);
  });

  test("returns 404 for empty tokens path", async () => {
    const response = await awaitTestRequest("/t/");
    expect(response.status).toBe(404);
  });

  test("shows quantity per ticket", async () => {
    const { token } = await createTestAttendeeWithToken("Carol", "carol@test.com", { maxQuantity: 5 }, 3);

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("3");
  });

  test("skips invalid tokens among valid ones", async () => {
    const { event, token } = await createTestAttendeeWithToken("Dave", "dave@test.com");

    const response = await awaitTestRequest(`/t/${token}+bad-token`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(event.name);
  });

  test("returns null for non-GET methods", async () => {
    const { routeTicketView } = await import("#routes/tickets.ts");
    const request = new Request("http://localhost/t/some-token", { method: "POST" });
    const result = await routeTicketView(request, "/t/some-token", "POST");
    expect(result).toBeNull();
  });

  test("attendee has a unique ticket_token after creation", async () => {
    const event = await createTestEvent({ maxAttendees: 10 });
    await createTestAttendee(event.id, event.slug, "Frank", "frank@test.com");
    await createTestAttendee(event.id, event.slug, "Grace", "grace@test.com");
    const attendees = await getAttendeesRaw(event.id);

    expect(attendees[0]!.ticket_token).not.toBe("");
    expect(attendees[1]!.ticket_token).not.toBe("");
    expect(attendees[0]!.ticket_token).not.toBe(attendees[1]!.ticket_token);
  });

  test("includes inline SVG QR code in ticket view", async () => {
    const { token } = await createTestAttendeeWithToken("Eve", "eve@test.com");

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("<svg");
    expect(body).toContain("</svg>");
  });

  test("displays booked date for daily event tickets", async () => {
    const event = await createDailyTestEvent({ maxAttendees: 10, maximumDaysAfter: 30 });
    const date = "2026-02-15";
    const result = await createAttendeeAtomic({
      eventId: event.id,
      name: "Zara",
      email: "zara@test.com",
      date,
    });
    if (!result.success) throw new Error("Failed to create attendee");

    const response = await awaitTestRequest(`/t/${result.attendee.ticket_token}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(formatDateLabel(date));
    expect(body).toContain("<th>Date</th>");
  });

  test("shows date for daily event and empty cell for standard event on same ticket", async () => {
    const dailyEvent = await createTestEvent({
      maxAttendees: 10,
      eventType: "daily",
      bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
      minimumDaysBefore: 0,
      maximumDaysAfter: 30,
    });
    const { token: tokenB } = await createTestAttendeeWithToken("Mixed", "mixed@test.com");
    const date = "2026-02-15";
    const dailyResult = await createAttendeeAtomic({
      eventId: dailyEvent.id,
      name: "Mixed",
      email: "mixed@test.com",
      date,
    });
    if (!dailyResult.success) throw new Error("Failed to create daily attendee");
    const tokenA = dailyResult.attendee.ticket_token;

    const response = await awaitTestRequest(`/t/${tokenA}+${tokenB}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(formatDateLabel(date));
    expect(body).toContain("<th>Date</th>");
    expect(body).toContain(dailyEvent.name);
  });

  test("does not show date column for standard event tickets", async () => {
    const { token } = await createTestAttendeeWithToken("Alice", "alice@test.com");

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).not.toContain("<th>Date</th>");
  });

  test("shows Event Date column when event has a date", async () => {
    const { token } = await createTestAttendeeWithToken("Alice", "alice@test.com", {
      date: "2026-06-15T14:00",
      location: "Village Hall",
    });

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<th>Event Date</th>");
    expect(body).toContain("<th>Location</th>");
    expect(body).toContain("Village Hall");
  });

  test("does not show Event Date or Location columns when both are empty", async () => {
    const { token } = await createTestAttendeeWithToken("Bob", "bob@test.com");

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("<th>Event Date</th>");
    expect(body).not.toContain("<th>Location</th>");
  });
});
