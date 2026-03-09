import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { registrationConfirmation } from "#templates/email/registration-confirmation.ts";
import { adminNotification } from "#templates/email/admin-notification.ts";
import type { RegistrationEntry, WebhookAttendee, WebhookEvent } from "#lib/webhook.ts";
import { setCurrencyCodeForTest, resetCurrencyCode } from "#lib/currency.ts";

const makeEvent = (overrides: Partial<WebhookEvent> = {}): WebhookEvent => ({
  id: 1,
  name: "Test Event",
  slug: "test-event",
  webhook_url: "",
  max_attendees: 100,
  attendee_count: 10,
  unit_price: 0,
  can_pay_more: false,
  ...overrides,
});

const makeAttendee = (overrides: Partial<WebhookAttendee> = {}): WebhookAttendee => ({
  id: 42,
  quantity: 1,
  name: "Jane Doe",
  email: "jane@example.com",
  phone: "555-1234",
  address: "",
  special_instructions: "",
  payment_id: "",
  price_paid: "0",
  ticket_token: "AABB001122",
  date: null,
  ...overrides,
});

const makeEntry = (
  eventOverrides?: Partial<WebhookEvent>,
  attendeeOverrides?: Partial<WebhookAttendee>,
): RegistrationEntry => ({
  event: makeEvent(eventOverrides),
  attendee: makeAttendee(attendeeOverrides),
});

describe("registrationConfirmation", () => {
  test("subject contains event name", () => {
    const { subject } = registrationConfirmation([makeEntry()], "GBP", "https://example.com/t/ABC");
    expect(subject).toBe("Your tickets for Test Event");
  });

  test("subject contains multiple event names for multi-event", () => {
    const entries = [
      makeEntry({ name: "Event A" }),
      makeEntry({ name: "Event B" }),
    ];
    const { subject } = registrationConfirmation(entries, "GBP", "https://example.com/t/ABC+DEF");
    expect(subject).toBe("Your tickets for Event A and Event B");
  });

  test("HTML contains event name and ticket URL", () => {
    const { html } = registrationConfirmation([makeEntry()], "GBP", "https://example.com/t/ABC");
    expect(html).toContain("Test Event");
    expect(html).toContain("https://example.com/t/ABC");
  });

  test("text contains event name and ticket URL", () => {
    const { text } = registrationConfirmation([makeEntry()], "GBP", "https://example.com/t/ABC");
    expect(text).toContain("Test Event");
    expect(text).toContain("https://example.com/t/ABC");
  });

  test("shows quantity in text", () => {
    const { text } = registrationConfirmation(
      [makeEntry({}, { quantity: 3 })],
      "GBP",
      "https://example.com/t/ABC",
    );
    expect(text).toContain("3 tickets");
  });

  test("shows singular ticket for quantity 1", () => {
    const { text } = registrationConfirmation([makeEntry()], "GBP", "https://example.com/t/ABC");
    expect(text).toContain("1 ticket");
    expect(text).not.toContain("1 tickets");
  });

  test("shows price for paid event", () => {
    setCurrencyCodeForTest("GBP");
    const { text } = registrationConfirmation(
      [makeEntry({ unit_price: 1000 }, { price_paid: "2000", quantity: 2 })],
      "GBP",
      "https://example.com/t/ABC",
    );
    expect(text).toContain("£20");
    resetCurrencyCode();
  });

  test("does not show price for free event", () => {
    const { text } = registrationConfirmation([makeEntry()], "GBP", "https://example.com/t/ABC");
    expect(text).not.toContain("£");
  });

  test("shows date when attendee has date", () => {
    const { text } = registrationConfirmation(
      [makeEntry({}, { date: "2025-07-15" })],
      "GBP",
      "https://example.com/t/ABC",
    );
    expect(text).toContain("2025-07-15");
  });
});

describe("adminNotification", () => {
  test("subject contains attendee name and event name", () => {
    const { subject } = adminNotification([makeEntry()], "GBP");
    expect(subject).toBe("New registration: Jane Doe for Test Event");
  });

  test("subject contains multiple event names for multi-event", () => {
    const entries = [
      makeEntry({ name: "Event A" }),
      makeEntry({ name: "Event B" }),
    ];
    const { subject } = adminNotification(entries, "GBP");
    expect(subject).toBe("New registration: Jane Doe for Event A and Event B");
  });

  test("HTML contains attendee name and event name", () => {
    const { html } = adminNotification([makeEntry()], "GBP");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("Test Event");
  });

  test("text contains attendee contact info", () => {
    const { text } = adminNotification([makeEntry()], "GBP");
    expect(text).toContain("Name: Jane Doe");
    expect(text).toContain("Email: jane@example.com");
    expect(text).toContain("Phone: 555-1234");
  });

  test("text omits empty contact fields", () => {
    const { text } = adminNotification(
      [makeEntry({}, { email: "", phone: "", address: "", special_instructions: "" })],
      "GBP",
    );
    expect(text).not.toContain("Email:");
    expect(text).not.toContain("Phone:");
    expect(text).not.toContain("Address:");
    expect(text).not.toContain("Notes:");
  });

  test("shows quantity in text", () => {
    const { text } = adminNotification(
      [makeEntry({}, { quantity: 3 })],
      "GBP",
    );
    expect(text).toContain("3 tickets");
  });

  test("shows price for paid event", () => {
    setCurrencyCodeForTest("GBP");
    const { text } = adminNotification(
      [makeEntry({ unit_price: 500 }, { price_paid: "500" })],
      "GBP",
    );
    expect(text).toContain("£5");
    resetCurrencyCode();
  });

  test("includes address when present", () => {
    const { text, html } = adminNotification(
      [makeEntry({}, { address: "123 Main St" })],
      "GBP",
    );
    expect(text).toContain("Address: 123 Main St");
    expect(html).toContain("Address: 123 Main St");
  });

  test("includes special instructions when present", () => {
    const { text, html } = adminNotification(
      [makeEntry({}, { special_instructions: "Wheelchair access" })],
      "GBP",
    );
    expect(text).toContain("Notes: Wheelchair access");
    expect(html).toContain("Notes: Wheelchair access");
  });
});
