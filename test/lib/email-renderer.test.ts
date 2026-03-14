import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  buildTemplateData,
  renderEmailContent,
  renderTemplate,
  resetEngine,
  validateTemplate,
} from "#lib/email-renderer.ts";
import type { TemplateData } from "#lib/email-renderer.ts";
import type { EmailEntry, EmailEvent } from "#lib/email.ts";
import type { WebhookAttendee } from "#lib/webhook.ts";
import { createTestDbWithSetup, resetDb } from "#test-utils";
import { setCurrencyCodeForTest, resetCurrencyCode } from "#lib/currency.ts";
import {
  invalidateSettingsCache,
  updateEmailTemplate,
} from "#lib/db/settings.ts";
import { spy, stub } from "@std/testing/mock";
import { map } from "#fp";
import { Liquid } from "liquidjs";

const makeEvent = (overrides: Partial<EmailEvent> = {}): EmailEvent => ({
  id: 1,
  name: "Test Event",
  slug: "test-event",
  webhook_url: "",
  max_attendees: 100,
  attendee_count: 10,
  unit_price: 0,
  can_pay_more: false,
  date: "",
  location: "",
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
  eventOverrides?: Partial<EmailEvent>,
  attendeeOverrides?: Partial<WebhookAttendee>,
): EmailEntry => ({
  event: makeEvent(eventOverrides),
  attendee: makeAttendee(attendeeOverrides),
});

describe("email-renderer", () => {
  beforeEach(async () => {
    setCurrencyCodeForTest("GBP");
    resetEngine();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetCurrencyCode();
    resetEngine();
    resetDb();
  });

  describe("buildTemplateData", () => {
    test("builds correct data shape from single entry", () => {
      const entries = [makeEntry()];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");

      expect(data.event_names).toBe("Test Event");
      expect(data.ticket_url).toBe("https://example.com/t/ABC");
      expect(data.currency).toBe("GBP");
      expect(data.entries.length).toBe(1);
      expect(data.entries[0]!.event.name).toBe("Test Event");
      expect(data.entries[0]!.event.slug).toBe("test-event");
      expect(data.entries[0]!.event.is_paid).toBe(false);
      expect(data.attendee.name).toBe("Jane Doe");
      expect(data.attendee.email).toBe("jane@example.com");
    });

    test("builds correct data shape from multiple entries", () => {
      const entries = [
        makeEntry({ name: "Event A" }),
        makeEntry({ name: "Event B" }),
      ];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC+DEF");

      expect(data.event_names).toBe("Event A and Event B");
      expect(data.entries.length).toBe(2);
      expect(data.attendee.name).toBe("Jane Doe");
    });

    test("formats three or more event names with commas and 'and'", () => {
      const entries = [
        makeEntry({ name: "Event A" }),
        makeEntry({ name: "Event B" }),
        makeEntry({ name: "Event C" }),
      ];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC+DEF+GHI");

      expect(data.event_names).toBe("Event A, Event B, and Event C");
    });

    test("marks paid events correctly", () => {
      const entries = [makeEntry({ unit_price: 1000 })];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");

      expect(data.entries[0]!.event.is_paid).toBe(true);
    });

    test("marks can_pay_more events as paid", () => {
      const entries = [makeEntry({ unit_price: 0, can_pay_more: true })];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");

      expect(data.entries[0]!.event.is_paid).toBe(true);
    });

    test("includes attendee date when present", () => {
      const entries = [makeEntry({}, { date: "2026-04-15" })];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");

      expect(data.entries[0]!.attendee.date).toBe("2026-04-15");
    });
  });

  describe("renderTemplate", () => {
    const sampleData: TemplateData = {
      entries: [{
        event: { name: "Concert", slug: "concert", is_paid: true },
        attendee: {
          name: "Jane", email: "jane@test.com", phone: "555",
          address: "123 St", special_instructions: "",
          quantity: 2, price_paid: "2000", date: null,
        },
      }],
      event_names: "Concert",
      attendee: {
        name: "Jane", email: "jane@test.com", phone: "555",
        address: "123 St", special_instructions: "",
        quantity: 2, price_paid: "2000", date: null,
      },
      ticket_url: "https://example.com/t/ABC",
      currency: "GBP",
    };

    test("renders simple variable interpolation", async () => {
      const result = await renderTemplate("Hello {{ attendee.name }}", sampleData);
      expect(result).toBe("Hello Jane");
    });

    test("renders event_names variable", async () => {
      const result = await renderTemplate("For {{ event_names }}", sampleData);
      expect(result).toBe("For Concert");
    });

    test("renders ticket_url variable", async () => {
      const result = await renderTemplate("{{ ticket_url }}", sampleData);
      expect(result).toBe("https://example.com/t/ABC");
    });

    test("renders currency filter", async () => {
      const result = await renderTemplate("{{ 2000 | currency }}", sampleData);
      expect(result).toBe("£20");
    });

    test("renders currency filter with string value", async () => {
      const result = await renderTemplate(
        "{% for entry in entries %}{{ entry.attendee.price_paid | currency }}{% endfor %}",
        sampleData,
      );
      expect(result).toBe("£20");
    });

    test("renders pluralize filter for singular", async () => {
      const data = { ...sampleData, entries: [{ ...sampleData.entries[0]!, attendee: { ...sampleData.entries[0]!.attendee, quantity: 1 } }] };
      const result = await renderTemplate(
        "{% for entry in entries %}{{ entry.attendee.quantity }} {{ entry.attendee.quantity | pluralize: \"ticket\", \"tickets\" }}{% endfor %}",
        data,
      );
      expect(result).toBe("1 ticket");
    });

    test("renders pluralize filter for plural", async () => {
      const result = await renderTemplate(
        "{% for entry in entries %}{{ entry.attendee.quantity }} {{ entry.attendee.quantity | pluralize: \"ticket\", \"tickets\" }}{% endfor %}",
        sampleData,
      );
      expect(result).toBe("2 tickets");
    });

    test("renders for loop over entries", async () => {
      const data: TemplateData = {
        ...sampleData,
        entries: [
          { ...sampleData.entries[0]!, event: { name: "Event A", slug: "a", is_paid: false } },
          { ...sampleData.entries[0]!, event: { name: "Event B", slug: "b", is_paid: false } },
        ],
      };
      const result = await renderTemplate(
        "{% for entry in entries %}{{ entry.event.name }} {% endfor %}",
        data,
      );
      expect(result).toBe("Event A Event B");
    });

    test("renders conditional on is_paid", async () => {
      const result = await renderTemplate(
        "{% for entry in entries %}{% if entry.event.is_paid %}paid{% else %}free{% endif %}{% endfor %}",
        sampleData,
      );
      expect(result).toBe("paid");
    });

    test("renders conditional on attendee date", async () => {
      const data: TemplateData = {
        ...sampleData,
        entries: [{ ...sampleData.entries[0]!, attendee: { ...sampleData.entries[0]!.attendee, date: "2026-04-15" } }],
      };
      const result = await renderTemplate(
        "{% for entry in entries %}{% if entry.attendee.date %}{{ entry.attendee.date }}{% endif %}{% endfor %}",
        data,
      );
      expect(result).toBe("2026-04-15");
    });

    test("trims whitespace from rendered output", async () => {
      const result = await renderTemplate("  hello  ", sampleData);
      expect(result).toBe("hello");
    });
  });

  describe("renderEmailContent", () => {
    test("uses default templates when no custom templates are set", async () => {
      const entries = [makeEntry()];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");

      const result = await renderEmailContent("confirmation", data);

      expect(result.subject).toContain("Test Event");
      expect(result.html).toContain("Test Event");
      expect(result.html).toContain("https://example.com/t/ABC");
      expect(result.text).toContain("Test Event");
      expect(result.text).toContain("https://example.com/t/ABC");
    });

    test("uses custom templates when set", async () => {
      await updateEmailTemplate("confirmation", "subject", "Custom: {{ event_names }}");
      await updateEmailTemplate("confirmation", "html", "<b>Custom HTML for {{ attendee.name }}</b>");
      await updateEmailTemplate("confirmation", "text", "Custom text for {{ attendee.name }}");
      invalidateSettingsCache();

      const entries = [makeEntry()];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");
      const result = await renderEmailContent("confirmation", data);

      expect(result.subject).toBe("Custom: Test Event");
      expect(result.html).toBe("<b>Custom HTML for Jane Doe</b>");
      expect(result.text).toBe("Custom text for Jane Doe");
    });

    test("falls back to default on custom template render error", async () => {
      await updateEmailTemplate("confirmation", "subject", "{{ invalid | nonexistent_filter }}");
      invalidateSettingsCache();

      const errorSpy = spy(console, "error");
      try {
        const entries = [makeEntry()];
        const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");
        const result = await renderEmailContent("confirmation", data);

        // Should fall back to default subject
        expect(result.subject).toContain("Test Event");
        // Should have logged the error
        const logs = map((c: { args: unknown[] }) => c.args[0] as string)(errorSpy.calls);
        expect(logs.some((l) => l.includes("E_EMAIL_TEMPLATE_RENDER") && l.includes("template render error"))).toBe(true);
      } finally {
        errorSpy.restore();
      }
    });

    test("renders admin notification defaults correctly", async () => {
      const entries = [makeEntry()];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");

      const result = await renderEmailContent("admin", data);

      expect(result.subject).toContain("Jane Doe");
      expect(result.subject).toContain("Test Event");
      expect(result.html).toContain("Jane Doe");
      expect(result.text).toContain("Name: Jane Doe");
    });

    test("renders admin notification with contact details", async () => {
      const entries = [makeEntry({}, {
        phone: "555-1234",
        address: "123 Main St",
        special_instructions: "Wheelchair",
      })];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");

      const result = await renderEmailContent("admin", data);

      expect(result.text).toContain("Phone: 555-1234");
      expect(result.text).toContain("Address: 123 Main St");
      expect(result.text).toContain("Notes: Wheelchair");
    });

    test("omits empty contact fields in admin notification", async () => {
      const entries = [makeEntry({}, { phone: "", address: "", special_instructions: "" })];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");

      const result = await renderEmailContent("admin", data);

      expect(result.text).not.toContain("Phone:");
      expect(result.text).not.toContain("Address:");
      expect(result.text).not.toContain("Notes:");
    });

    test("renders paid event with currency in confirmation", async () => {
      const entries = [makeEntry({ unit_price: 1000 }, { price_paid: "2000", quantity: 2 })];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");

      const result = await renderEmailContent("confirmation", data);

      expect(result.html).toContain("£20");
      expect(result.text).toContain("£20");
    });

    test("shows date when attendee has date", async () => {
      const entries = [makeEntry({}, { date: "2026-07-15" })];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");

      const result = await renderEmailContent("confirmation", data);

      expect(result.html).toContain("2026-07-15");
      expect(result.text).toContain("2026-07-15");
    });

    test("uses mix of custom and default parts", async () => {
      await updateEmailTemplate("confirmation", "subject", "Custom Subject: {{ event_names }}");
      // html and text remain default
      invalidateSettingsCache();

      const entries = [makeEntry()];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");
      const result = await renderEmailContent("confirmation", data);

      expect(result.subject).toBe("Custom Subject: Test Event");
      // html and text should still use defaults
      expect(result.html).toContain("Thanks for registering!");
      expect(result.text).toContain("Thanks for registering!");
    });

    test("logs non-Error thrown values as strings", async () => {
      await updateEmailTemplate("confirmation", "subject", "Custom {{ event_names }}");
      invalidateSettingsCache();

      // Stub parseAndRender to throw a non-Error value on first call, then succeed
      let callCount = 0;
      const original = Liquid.prototype.parseAndRender;
      const parseAndRenderStub = stub(
        Liquid.prototype,
        "parseAndRender",
        function (this: InstanceType<typeof Liquid>, ...args: Parameters<typeof original>) {
          if (callCount++ === 0) throw "string error value";
          return original.apply(this, args);
        },
      );
      const errorSpy = spy(console, "error");
      try {
        const entries = [makeEntry()];
        const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");
        await renderEmailContent("confirmation", data);

        const logs = map((c: { args: unknown[] }) => c.args[0] as string)(errorSpy.calls);
        expect(logs.some((l) => l.includes("string error value"))).toBe(true);
      } finally {
        parseAndRenderStub.restore();
        errorSpy.restore();
      }
    });

    test("resets to defaults after clearing custom template", async () => {
      await updateEmailTemplate("confirmation", "subject", "Custom Subject");
      invalidateSettingsCache();

      await updateEmailTemplate("confirmation", "subject", "");
      invalidateSettingsCache();

      const entries = [makeEntry()];
      const data = buildTemplateData(entries, "GBP", "https://example.com/t/ABC");
      const result = await renderEmailContent("confirmation", data);

      expect(result.subject).toContain("Test Event");
    });
  });

  describe("validateTemplate", () => {
    test("returns null for valid template", () => {
      expect(validateTemplate("Hello {{ name }}")).toBeNull();
    });

    test("returns null for template with for loop", () => {
      expect(validateTemplate("{% for x in items %}{{ x }}{% endfor %}")).toBeNull();
    });

    test("returns error for unclosed tag", () => {
      const error = validateTemplate("{% for x in items %}{{ x }}");
      expect(error).not.toBeNull();
    });

    test("returns error for invalid syntax", () => {
      const error = validateTemplate("{% invalid_tag %}");
      expect(error).not.toBeNull();
    });

    test("returns null for empty template", () => {
      expect(validateTemplate("")).toBeNull();
    });

    test("returns string representation of non-Error thrown value", () => {
      const parseStub = stub(
        Liquid.prototype,
        "parse",
        () => { throw "raw string parse error"; },
      );
      try {
        const result = validateTemplate("anything");
        expect(result).toBe("raw string parse error");
      } finally {
        parseStub.restore();
      }
    });
  });
});
