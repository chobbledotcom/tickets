import { beforeEach, afterEach, describe, expect, test } from "#test-compat";
import { addDays } from "#lib/dates.ts";
import { todayInTz } from "#lib/timezone.ts";
import {
  awaitTestRequest,
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
      await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const response = await awaitTestRequest("/admin/calendar", { cookie });
      const html = await response.text();
      // Should contain at least one date option
      expect(html).toContain("disabled");
    });

    test("includes attendee dates in dropdown", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      await submitTicketForm(event.slug, {
        name: "User A",
        email: "a@test.com",
        date: validDate,
      });
      const response = await awaitTestRequest("/admin/calendar", { cookie });
      const html = await response.text();
      // The date with a booking should be selectable (not disabled)
      expect(html).toContain(`date=${validDate}`);
    });

    test("filters attendees by date parameter", async () => {
      const date1 = addDays(todayInTz("UTC"), 1);
      const date2 = addDays(todayInTz("UTC"), 2);
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      await submitTicketForm(event.slug, {
        name: "User A",
        email: "a@test.com",
        date: date1,
      });
      await submitTicketForm(event.slug, {
        name: "User B",
        email: "b@test.com",
        date: date2,
      });

      const response = await awaitTestRequest(`/admin/calendar?date=${date1}`, { cookie });
      const html = await response.text();
      expect(html).toContain("User A");
      expect(html).not.toContain("User B");
    });

    test("shows attendees from multiple daily events for same date", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event1 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const event2 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      await submitTicketForm(event1.slug, {
        name: "User A",
        email: "a@test.com",
        date: validDate,
      });
      await submitTicketForm(event2.slug, {
        name: "User B",
        email: "b@test.com",
        date: validDate,
      });

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
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      await submitTicketForm(event.slug, {
        name: "User A",
        email: "a@test.com",
        date: validDate,
      });

      const response = await awaitTestRequest(`/admin/calendar?date=${validDate}`, { cookie });
      const html = await response.text();
      expect(html).toContain(`href="/admin/event/${event.id}"`);
    });

    test("shows Export CSV link when attendees exist for date", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      await submitTicketForm(event.slug, {
        name: "User A",
        email: "a@test.com",
        date: validDate,
      });

      const response = await awaitTestRequest(`/admin/calendar?date=${validDate}`, { cookie });
      const html = await response.text();
      expect(html).toContain("Export CSV");
      expect(html).toContain(`/admin/calendar/export?date=${validDate}`);
    });

    test("does not show Export CSV link when no attendees for date", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });

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

    test("excludes standard event attendees", async () => {
      await createTestEvent({ name: "Standard Event" });
      const response = await awaitTestRequest("/admin/calendar", { cookie });
      const html = await response.text();
      expect(html).not.toContain("Standard Event");
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
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      await submitTicketForm(event.slug, {
        name: "User A",
        email: "a@test.com",
        date: validDate,
      });

      const response = await awaitTestRequest(`/admin/calendar/export?date=${validDate}`, { cookie });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(response.headers.get("content-disposition")).toContain("attachment");
      expect(response.headers.get("content-disposition")).toContain(`calendar_${validDate}_attendees.csv`);
    });

    test("includes Event and Date columns in CSV", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      await submitTicketForm(event.slug, {
        name: "User A",
        email: "a@test.com",
        date: validDate,
      });

      const response = await awaitTestRequest(`/admin/calendar/export?date=${validDate}`, { cookie });
      const csv = await response.text();
      const lines = csv.split("\n");
      expect(lines[0]).toBe("Event,Date,Name,Email,Phone,Address,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL");
      expect(lines[1]).toContain(event.name);
      expect(lines[1]).toContain(validDate);
      expect(lines[1]).toContain("User A");
    });

    test("includes attendees from multiple events", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      const event1 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const event2 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      await submitTicketForm(event1.slug, {
        name: "User A",
        email: "a@test.com",
        date: validDate,
      });
      await submitTicketForm(event2.slug, {
        name: "User B",
        email: "b@test.com",
        date: validDate,
      });

      const response = await awaitTestRequest(`/admin/calendar/export?date=${validDate}`, { cookie });
      const csv = await response.text();
      expect(csv).toContain("User A");
      expect(csv).toContain("User B");
      expect(csv).toContain(event1.name);
      expect(csv).toContain(event2.name);
    });

    test("returns empty CSV when no attendees for date", async () => {
      const validDate = addDays(todayInTz("UTC"), 1);
      await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });

      const response = await awaitTestRequest(`/admin/calendar/export?date=${validDate}`, { cookie });
      const csv = await response.text();
      const lines = csv.split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("Event,Date,Name");
    });
  });
});
