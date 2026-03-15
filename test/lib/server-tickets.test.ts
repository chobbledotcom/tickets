import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { formatCurrency } from "#lib/currency.ts";
import { formatDateLabel } from "#lib/dates.ts";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import { eventsTable } from "#lib/db/events.ts";
import {
  awaitTestRequest,
  createDailyTestAttendee,
  createPaidTestAttendee,
  createTestAttendee,
  createTestAttendeeWithToken,
  createTestDbWithSetup,
  createTestEvent,
  expectHtmlResponse,
  getAttendeesRaw,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

/** Fetch a ticket page and return the response body text */
const fetchTicketBody = async (tokenPath: string): Promise<string> => {
  const response = await awaitTestRequest(`/t/${tokenPath}`);
  return response.text();
};

describe("ticket view (/t/:tokens)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  test("displays ticket for a single valid token", async () => {
    const { event, token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(event.name);
    expect(body).toContain("Your Tickets");
  });

  test("displays tickets for multiple valid tokens", async () => {
    const { event: eventA, token: tokenA } = await createTestAttendeeWithToken(
      "Bob",
      "bob@test.com",
    );
    const { event: eventB, token: tokenB } = await createTestAttendeeWithToken(
      "Bob",
      "bob@test.com",
      {},
      2,
    );

    const body = await fetchTicketBody(`${tokenA}+${tokenB}`);
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

  test("shows quantity when greater than 1", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Carol",
      "carol@test.com",
      { maxQuantity: 5 },
      3,
    );

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("Quantity: 3");
  });

  test("shows quantity when equal to 1", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Carol",
      "carol@test.com",
    );

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("Quantity: 1");
  });

  test("skips invalid tokens among valid ones", async () => {
    const { event, token } = await createTestAttendeeWithToken(
      "Dave",
      "dave@test.com",
    );

    const response = await awaitTestRequest(`/t/${token}+bad-token`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(event.name);
  });

  test("returns null for non-GET methods", async () => {
    const { routeTicketView } = await import("#routes/tickets.ts");
    const request = new Request("http://localhost/t/some-token", {
      method: "POST",
    });
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
    const date = "2026-02-15";
    const { token } = await createDailyTestAttendee(
      "Zara",
      "zara@test.com",
      date,
    );

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(formatDateLabel(date));
    expect(body).toContain("Booking Date");
  });

  test("shows date for daily event and shows standard event without date on same ticket page", async () => {
    const date = "2026-02-15";
    const { event: dailyEvent, token: tokenA } = await createDailyTestAttendee(
      "Mixed",
      "mixed@test.com",
      date,
    );
    const { event: standardEvent, token: tokenB } =
      await createTestAttendeeWithToken("Mixed", "mixed@test.com");

    const response = await awaitTestRequest(`/t/${tokenA}+${tokenB}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(formatDateLabel(date));
    expect(body).toContain("Booking Date");
    expect(body).toContain(dailyEvent.name);
    expect(body).toContain(standardEvent.name);
    expect(body).toContain("2 Tickets");
  });

  test("does not show booking date for standard event tickets", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const body = await fetchTicketBody(token);
    expect(body).not.toContain("Booking Date");
  });

  test("shows event date and location when event has them", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
      {
        date: "2026-06-15T14:00",
        location: "Village Hall",
      },
    );

    const response = await awaitTestRequest(`/t/${token}`);
    await expectHtmlResponse(
      response,
      200,
      "ticket-card-date",
      "ticket-card-location",
      "Village Hall",
    );
  });

  test("does not show event date or location when both are empty", async () => {
    const { token } = await createTestAttendeeWithToken("Bob", "bob@test.com");

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("ticket-card-date");
    expect(body).not.toContain("ticket-card-location");
  });

  test("shows event description when present", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
      {
        description: "A wonderful event",
      },
    );

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("ticket-card-description");
    expect(body).toContain("A wonderful event");
  });

  test("does not show description when empty", async () => {
    const { token } = await createTestAttendeeWithToken("Bob", "bob@test.com");

    const body = await fetchTicketBody(token);
    expect(body).not.toContain("ticket-card-description");
  });

  test("shows price for paid tickets", async () => {
    const event = await createTestEvent({ maxAttendees: 10, unitPrice: 1500 });
    const attendee = await createPaidTestAttendee(
      event.id,
      "Alice",
      "alice@test.com",
      "pi_test",
      1500,
    );

    const response = await awaitTestRequest(`/t/${attendee.ticket_token}`);
    const body = await response.text();
    expect(body).toContain("ticket-card-price");
    expect(body).toContain(formatCurrency(1500));
  });

  test("does not show price for free tickets", async () => {
    const { token } = await createTestAttendeeWithToken("Bob", "bob@test.com");

    const body = await fetchTicketBody(token);
    expect(body).not.toContain("ticket-card-price");
  });

  test("displays ticket token on ticket page", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("ticket-card-token");
    expect(body).toContain(token);
  });

  test("shows non-transferable notice for non-transferable event", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice Smith",
      "alice@test.com",
      { nonTransferable: true },
    );

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("ticket-card-notice");
    expect(body).toContain("Non-transferable");
    expect(body).toContain("ID required at entry");
  });

  test("does not show non-transferable notice for transferable event", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Bob Jones",
      "bob@test.com",
    );

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("ticket-card-notice");
    expect(body).not.toContain("Non-transferable");
  });

  test("shows attachment download link when event has attachment", async () => {
    const { event, token } = await createTestAttendeeWithToken(
      "Alice Smith",
      "alice@test.com",
    );
    await eventsTable.update(event.id, {
      attachmentUrl: "abc-guide.pdf",
      attachmentName: "Event Guide.pdf",
    });

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("attachment-link");
    expect(body).toContain("Download: Event Guide.pdf");
    expect(body).toContain("/attachment/");
  });

  test("does not show attachment link when event has no attachment", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Bob Jones",
      "bob@test.com",
    );

    const response = await awaitTestRequest(`/t/${token}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("attachment-link");
    expect(body).not.toContain("Download:");
  });
});
