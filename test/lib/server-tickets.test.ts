import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  awaitTestRequest,
  createTestAttendee,
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
    const event = await createTestEvent({ maxAttendees: 10 });
    await createTestAttendee(event.id, event.slug, "Alice", "alice@test.com");
    const attendees = await getAttendeesRaw(event.id);
    const token = attendees[0]!.ticket_token;

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(event.name);
    expect(body).toContain("Your Tickets");
  });

  test("displays tickets for multiple valid tokens", async () => {
    const eventA = await createTestEvent({ maxAttendees: 10 });
    const eventB = await createTestEvent({ maxAttendees: 10 });
    await createTestAttendee(eventA.id, eventA.slug, "Bob", "bob@test.com");
    await createTestAttendee(eventB.id, eventB.slug, "Bob", "bob@test.com", 2);
    const attendeesA = await getAttendeesRaw(eventA.id);
    const attendeesB = await getAttendeesRaw(eventB.id);
    const tokenA = attendeesA[0]!.ticket_token;
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
    const event = await createTestEvent({ maxAttendees: 10, maxQuantity: 5 });
    await createTestAttendee(event.id, event.slug, "Carol", "carol@test.com", 3);
    const attendees = await getAttendeesRaw(event.id);
    const token = attendees[0]!.ticket_token;

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("3");
  });

  test("skips invalid tokens among valid ones", async () => {
    const event = await createTestEvent({ maxAttendees: 10 });
    await createTestAttendee(event.id, event.slug, "Dave", "dave@test.com");
    const attendees = await getAttendeesRaw(event.id);
    const token = attendees[0]!.ticket_token;

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
    const event = await createTestEvent({ maxAttendees: 10 });
    await createTestAttendee(event.id, event.slug, "Eve", "eve@test.com");
    const attendees = await getAttendeesRaw(event.id);
    const token = attendees[0]!.ticket_token;

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("<svg");
    expect(body).toContain("</svg>");
  });
});
