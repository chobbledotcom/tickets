import { beforeEach, afterEach, describe, expect, test } from "#test-compat";
import { addDays } from "#lib/dates.ts";
import { todayInTz } from "#lib/timezone.ts";
import {
  awaitTestRequest,
  createDailyTestEvent,
  createTestEvent,
  createTestDbWithSetup,
  loginAsAdmin,
  resetDb,
  resetTestSlugCounter,
  submitTicketForm,
} from "#test-utils";

describe("admin calendar", () => {
  let cookie: string;

  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
    const session = await loginAsAdmin();
    cookie = session.cookie;
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/calendar", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await awaitTestRequest("/admin/calendar");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("renders calendar page when authenticated", async () => {
      const response = await awaitTestRequest("/admin/calendar", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Calendar");
      expect(html).toContain("Attendees by Date");
    });

    test("shows empty dropdown when no daily events exist", async () => {
      await createTestEvent({ name: "Standard Event" });
      const response = await awaitTestRequest("/admin/calendar", { cookie });
      const html = await response.text();
      expect(html).toContain("Select a date");
    });

    test("shows available dates from daily events", async () => {
      await createDailyTestEvent();
      const response = await awaitTestRequest("/admin/calendar", { cookie });
      const html = await response.text();
      // Should contain at least one date option
      expect(html).toContain("disabled");
    });

    test("includes attendee dates in dropdown", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event = await createDailyTestEvent();
      await submitTicketForm(event.slug, { name: "User A", email: "a@test.com", date: validDate });
      const response = await awaitTestRequest("/admin/calendar", { cookie });
      const html = await response.text();
      // The date with a booking should be selectable (not disabled)
      expect(html).toContain(`date=${validDate}`);
    });

    test("filters attendees by date parameter", async () => {
      const date1 = addDays(todayInTz("UTC"), 1);
      const date2 = addDays(todayInTz("UTC"), 2);
      const event = await createDailyTestEvent();
      await submitTicketForm(event.slug, { name: "User A", email: "a@test.com", date: date1 });
      await submitTicketForm(event.slug, { name: "User B", email: "b@test.com", date: date2 });

      const response = await awaitTestRequest(`/admin/calendar?date=${date1}`, { cookie });
      const html = await response.text();
      expect(html).toContain("User A");
      expect(html).not.toContain("User B");
    });

    test("shows attendees from multiple daily events for same date", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event1 = await createDailyTestEvent();
      const event2 = await createDailyTestEvent();
      await submitTicketForm(event1.slug, { name: "User A", email: "a@test.com", date: validDate });
      await submitTicketForm(event2.slug, { name: "User B", email: "b@test.com", date: validDate });

      const response = await awaitTestRequest(`/admin/calendar?date=${validDate}`, { cookie });
      const html = await response.text();
      expect(html).toContain("User A");
      expect(html).toContain("User B");
      // Both event names should appear
      expect(html).toContain(event1.name);
      expect(html).toContain(event2.name);
    });

    test("links event name to event page", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event = await createDailyTestEvent();
      await submitTicketForm(event.slug, { name: "User A", email: "a@test.com", date: validDate });

      const response = await awaitTestRequest(`/admin/calendar?date=${validDate}`, { cookie });
      const html = await response.text();
      expect(html).toContain(`href="/admin/event/${event.id}"`);
    });

    test("shows Export CSV link when attendees exist for date", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event = await createDailyTestEvent();
      await submitTicketForm(event.slug, { name: "User A", email: "a@test.com", date: validDate });

      const response = await awaitTestRequest(`/admin/calendar?date=${validDate}`, { cookie });
      const html = await response.text();
      expect(html).toContain("Export CSV");
      expect(html).toContain(`/admin/calendar/export?date=${validDate}`);
    });

    test("does not show Export CSV link when no attendees for date", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      await createDailyTestEvent();

      const response = await awaitTestRequest(`/admin/calendar?date=${validDate}`, { cookie });
      const html = await response.text();
      expect(html).not.toContain("Export CSV");
    });

    test("ignores invalid date parameter", async () => {
      const response = await awaitTestRequest("/admin/calendar?date=invalid", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Select a date above to view attendees");
    });

    test("excludes standard events without a date", async () => {
      await createTestEvent({ name: "Standard Event" });
      const response = await awaitTestRequest("/admin/calendar", { cookie });
      const html = await response.text();
      expect(html).not.toContain("Standard Event");
    });

    test("shows standard event date in dropdown", async () => {
      await createTestEvent({ name: "Concert", date: "2026-06-15T14:00" });
      const response = await awaitTestRequest("/admin/calendar", { cookie });
      const html = await response.text();
      // Standard event date appears as a formatted label in the dropdown
      expect(html).toContain("Monday 15 June 2026");
    });

    test("shows standard event attendees when date is selected", async () => {
      const event = await createTestEvent({ name: "Concert", date: "2026-06-15T14:00" });
      await submitTicketForm(event.slug, { name: "Concert Fan", email: "fan@test.com" });

      const response = await awaitTestRequest("/admin/calendar?date=2026-06-15", { cookie });
      const html = await response.text();
      expect(html).toContain("Concert Fan");
      expect(html).toContain("Concert");
    });

    test("does not show standard event attendees on wrong date", async () => {
      const event = await createTestEvent({ name: "Concert", date: "2026-06-15T14:00" });
      await submitTicketForm(event.slug, { name: "Concert Fan", email: "fan@test.com" });

      const response = await awaitTestRequest("/admin/calendar?date=2026-06-16", { cookie });
      const html = await response.text();
      expect(html).not.toContain("Concert Fan");
    });

    test("shows mixed daily and standard event attendees for same date", async () => {
      const eventDate = addDays(todayInTz("UTC"), 3);
      const dailyEvent = await createDailyTestEvent();
      const standardEvent = await createTestEvent({ name: "Workshop", date: `${eventDate}T10:00` });

      await submitTicketForm(dailyEvent.slug, { name: "Daily User", email: "daily@test.com", date: eventDate });
      await submitTicketForm(standardEvent.slug, { name: "Standard User", email: "standard@test.com" });

      const response = await awaitTestRequest(`/admin/calendar?date=${eventDate}`, { cookie });
      const html = await response.text();
      expect(html).toContain("Daily User");
      expect(html).toContain("Standard User");
      expect(html).toContain(dailyEvent.name);
      expect(html).toContain("Workshop");
    });

    test("marks standard event date as having bookings when attendees exist", async () => {
      const event = await createTestEvent({ name: "Concert", date: "2026-06-15T14:00" });
      await submitTicketForm(event.slug, { name: "Fan", email: "fan@test.com" });

      const response = await awaitTestRequest("/admin/calendar", { cookie });
      const html = await response.text();
      // Date with bookings should be a clickable link (not disabled)
      expect(html).toContain("date=2026-06-15");
    });

    test("shows multiple standard events on same date", async () => {
      const event1 = await createTestEvent({ name: "Morning Concert", date: "2026-06-15T10:00" });
      const event2 = await createTestEvent({ name: "Evening Concert", date: "2026-06-15T20:00" });
      await submitTicketForm(event1.slug, { name: "Morning Fan", email: "am@test.com" });
      await submitTicketForm(event2.slug, { name: "Evening Fan", email: "pm@test.com" });

      const response = await awaitTestRequest("/admin/calendar?date=2026-06-15", { cookie });
      const html = await response.text();
      expect(html).toContain("Morning Fan");
      expect(html).toContain("Evening Fan");
      expect(html).toContain("Morning Concert");
      expect(html).toContain("Evening Concert");
    });

    test("does not show standard attendees when no standard events match date", async () => {
      const event = await createTestEvent({ name: "Concert", date: "2026-06-15T14:00" });
      await submitTicketForm(event.slug, { name: "Fan", email: "fan@test.com" });

      // Request a completely different date
      const response = await awaitTestRequest("/admin/calendar?date=2026-07-01", { cookie });
      const html = await response.text();
      expect(html).not.toContain("Fan");
    });

    test("standard event date without attendees shows as disabled", async () => {
      await createTestEvent({ name: "Empty Event", date: "2026-06-15T14:00" });

      const response = await awaitTestRequest("/admin/calendar", { cookie });
      const html = await response.text();
      // The date should appear as a disabled option (no bookings)
      expect(html).toContain("<option disabled>Monday 15 June 2026</option>");
    });
  });

  describe("GET /admin/calendar/export", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await awaitTestRequest("/admin/calendar/export?date=2026-03-15");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("redirects to calendar when no date provided", async () => {
      const response = await awaitTestRequest("/admin/calendar/export", { cookie });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/calendar");
    });

    test("returns CSV with correct headers", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event = await createDailyTestEvent();
      await submitTicketForm(event.slug, { name: "User A", email: "a@test.com", date: validDate });

      const response = await awaitTestRequest(`/admin/calendar/export?date=${validDate}`, { cookie });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(response.headers.get("content-disposition")).toContain("attachment");
      expect(response.headers.get("content-disposition")).toContain(`calendar_${validDate}_attendees.csv`);
    });

    test("includes Event and Date columns in CSV", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event = await createDailyTestEvent();
      await submitTicketForm(event.slug, { name: "User A", email: "a@test.com", date: validDate });

      const response = await awaitTestRequest(`/admin/calendar/export?date=${validDate}`, { cookie });
      const csv = await response.text();
      const lines = csv.split("\n");
      expect(lines[0]).toBe("Event,Date,Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL");
      expect(lines[1]).toContain(event.name);
      expect(lines[1]).toContain(validDate);
      expect(lines[1]).toContain("User A");
    });

    test("includes attendees from multiple events", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event1 = await createDailyTestEvent();
      const event2 = await createDailyTestEvent();
      await submitTicketForm(event1.slug, { name: "User A", email: "a@test.com", date: validDate });
      await submitTicketForm(event2.slug, { name: "User B", email: "b@test.com", date: validDate });

      const response = await awaitTestRequest(`/admin/calendar/export?date=${validDate}`, { cookie });
      const csv = await response.text();
      expect(csv).toContain("User A");
      expect(csv).toContain("User B");
      expect(csv).toContain(event1.name);
      expect(csv).toContain(event2.name);
    });

    test("returns empty CSV when no attendees for date", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      await createDailyTestEvent();

      const response = await awaitTestRequest(`/admin/calendar/export?date=${validDate}`, { cookie });
      const csv = await response.text();
      const lines = csv.split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("Event,Date,Name");
    });

    test("includes standard event attendees in CSV export", async () => {
      const event = await createTestEvent({ name: "Concert", date: "2026-06-15T14:00" });
      await submitTicketForm(event.slug, { name: "CSV Fan", email: "csvfan@test.com" });

      const response = await awaitTestRequest("/admin/calendar/export?date=2026-06-15", { cookie });
      const csv = await response.text();
      expect(csv).toContain("Concert");
      expect(csv).toContain("CSV Fan");
    });

    test("includes mixed daily and standard attendees in CSV export", async () => {
      const eventDate = addDays(todayInTz("UTC"), 3);
      const dailyEvent = await createDailyTestEvent();
      const standardEvent = await createTestEvent({ name: "Workshop", date: `${eventDate}T10:00` });

      await submitTicketForm(dailyEvent.slug, { name: "Daily CSV", email: "daily@test.com", date: eventDate });
      await submitTicketForm(standardEvent.slug, { name: "Standard CSV", email: "standard@test.com" });

      const response = await awaitTestRequest(`/admin/calendar/export?date=${eventDate}`, { cookie });
      const csv = await response.text();
      expect(csv).toContain("Daily CSV");
      expect(csv).toContain("Standard CSV");
      expect(csv).toContain(dailyEvent.name);
      expect(csv).toContain("Workshop");
    });
  });
});
