import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { Liquid } from "liquidjs";
import { map } from "#fp";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import type { TemplateData } from "#shared/email-renderer.ts";
import {
  buildTemplateData,
  renderEmailContent,
  renderTemplate,
  resetEngine,
  validateTemplate,
} from "#shared/email-renderer.ts";
import {
  describeWithEnv,
  makeTestEntry as makeEntry,
  useSetting,
} from "#test-utils";

describeWithEnv("email-renderer", { db: true }, () => {
  useSetting({ currency: "GBP" });
  beforeEach(resetEngine);
  afterEach(resetEngine);

  describe("buildTemplateData", () => {
    test("builds correct data shape from single entry", () => {
      const entries = [makeEntry()];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      expect(data.listing_names).toBe("Test Listing");
      expect(data.ticket_url).toBe("https://example.com/t/ABC");
      expect(data.currency).toBe("GBP");
      expect(data.entries.length).toBe(1);
      expect(data.entries[0]!.listing.name).toBe("Test Listing");
      expect(data.entries[0]!.listing.slug).toBe("test-listing");
      expect(data.entries[0]!.listing.is_paid).toBe(false);
      expect(data.attendee.name).toBe("Jane Doe");
      expect(data.attendee.email).toBe("jane@example.com");
    });

    test("builds correct data shape from multiple entries", () => {
      const entries = [
        makeEntry({ name: "Listing A" }),
        makeEntry({ name: "Listing B" }),
      ];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC+DEF",
      );

      expect(data.listing_names).toBe("Listing A and Listing B");
      expect(data.entries.length).toBe(2);
      expect(data.attendee.name).toBe("Jane Doe");
    });

    test("formats three or more listing names with commas and 'and'", () => {
      const entries = [
        makeEntry({ name: "Listing A" }),
        makeEntry({ name: "Listing B" }),
        makeEntry({ name: "Listing C" }),
      ];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC+DEF+GHI",
      );

      expect(data.listing_names).toBe("Listing A, Listing B, and Listing C");
    });

    test("marks paid listings correctly", () => {
      const entries = [makeEntry({ unit_price: 1000 })];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      expect(data.entries[0]!.listing.is_paid).toBe(true);
    });

    test("marks can_pay_more listings as paid", () => {
      const entries = [makeEntry({ can_pay_more: true, unit_price: 0 })];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      expect(data.entries[0]!.listing.is_paid).toBe(true);
    });

    test("includes attendee date when present", () => {
      const entries = [makeEntry({}, { date: "2026-04-15" })];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      expect(data.entries[0]!.attendee.date).toBe("2026-04-15");
    });

    // Helper for the date_range_label tests — every case follows the same
    // makeEntry → buildTemplateData → read label flow.
    const dateRangeLabelFor = (
      listing: Partial<Parameters<typeof makeEntry>[0]>,
      attendee: Partial<Parameters<typeof makeEntry>[1]>,
    ): string =>
      buildTemplateData(
        [makeEntry(listing, attendee)],
        "GBP",
        "https://example.com/t/ABC",
      ).entries[0]!.attendee.date_range_label;

    test("date_range_label: single-day daily booking formats as a date", () => {
      expect(
        dateRangeLabelFor(
          { duration_days: 1, listing_type: "daily" },
          { date: "2026-04-15" },
        ),
      ).toContain("15 April");
    });

    test("date_range_label: multi-day booking uses en dash", () => {
      // The label comes from the booking's stored span (end_date is exclusive),
      // so a 3-day booking from the 15th ends (exclusive) on the 18th.
      expect(
        dateRangeLabelFor(
          { duration_days: 3, listing_type: "daily" },
          { date: "2026-04-15", end_date: "2026-04-18" },
        ),
      ).toBe("15\u201317 April 2026");
    });

    test("date_range_label: empty when no booking date", () => {
      expect(dateRangeLabelFor({}, { date: null })).toBe("");
    });
  });

  describe("renderTemplate", () => {
    const sampleData: TemplateData = {
      amount_owed: "0",
      attendee: {
        address: "123 St",
        date: null,
        date_range_label: "",
        email: "jane@test.com",
        name: "Jane",
        phone: "555",
        price_paid: "2000",
        quantity: 2,
        special_instructions: "",
      },
      currency: "GBP",
      entries: [
        {
          attendee: {
            address: "123 St",
            date: null,
            date_range_label: "",
            email: "jane@test.com",
            name: "Jane",
            phone: "555",
            price_paid: "2000",
            quantity: 2,
            special_instructions: "",
          },
          listing: { is_paid: true, name: "Concert", slug: "concert" },
        },
      ],
      listing_names: "Concert",
      ticket_url: "https://example.com/t/ABC",
    };

    test("renders simple variable interpolation", async () => {
      const result = await renderTemplate(
        "Hello {{ attendee.name }}",
        sampleData,
      );
      expect(result).toBe("Hello Jane");
    });

    test("renders listing_names variable", async () => {
      const result = await renderTemplate(
        "For {{ listing_names }}",
        sampleData,
      );
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
      const data = {
        ...sampleData,
        entries: [
          {
            ...sampleData.entries[0]!,
            attendee: { ...sampleData.entries[0]!.attendee, quantity: 1 },
          },
        ],
      };
      const result = await renderTemplate(
        '{% for entry in entries %}{{ entry.attendee.quantity }} {{ entry.attendee.quantity | pluralize: "ticket", "tickets" }}{% endfor %}',
        data,
      );
      expect(result).toBe("1 ticket");
    });

    test("renders pluralize filter for plural", async () => {
      const result = await renderTemplate(
        '{% for entry in entries %}{{ entry.attendee.quantity }} {{ entry.attendee.quantity | pluralize: "ticket", "tickets" }}{% endfor %}',
        sampleData,
      );
      expect(result).toBe("2 tickets");
    });

    test("renders for loop over entries", async () => {
      const data: TemplateData = {
        ...sampleData,
        entries: [
          {
            ...sampleData.entries[0]!,
            listing: { is_paid: false, name: "Listing A", slug: "a" },
          },
          {
            ...sampleData.entries[0]!,
            listing: { is_paid: false, name: "Listing B", slug: "b" },
          },
        ],
      };
      const result = await renderTemplate(
        "{% for entry in entries %}{{ entry.listing.name }} {% endfor %}",
        data,
      );
      expect(result).toBe("Listing A Listing B");
    });

    test("renders conditional on is_paid", async () => {
      const result = await renderTemplate(
        "{% for entry in entries %}{% if entry.listing.is_paid %}paid{% else %}free{% endif %}{% endfor %}",
        sampleData,
      );
      expect(result).toBe("paid");
    });

    test("renders conditional on attendee date", async () => {
      const data: TemplateData = {
        ...sampleData,
        entries: [
          {
            ...sampleData.entries[0]!,
            attendee: {
              ...sampleData.entries[0]!.attendee,
              date: "2026-04-15",
            },
          },
        ],
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
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      const result = await renderEmailContent("confirmation", data);

      expect(result.subject).toContain("Test Listing");
      expect(result.html).toContain("Test Listing");
      expect(result.html).toContain("https://example.com/t/ABC");
      expect(result.text).toContain("Test Listing");
      expect(result.text).toContain("https://example.com/t/ABC");
    });

    test("uses custom templates when set", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "Custom: {{ listing_names }}",
      );
      await settings.update.email.template(
        "confirmation",
        "html",
        "<b>Custom HTML for {{ attendee.name }}</b>",
      );
      await settings.update.email.template(
        "confirmation",
        "text",
        "Custom text for {{ attendee.name }}",
      );
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      const entries = [makeEntry()];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );
      const result = await renderEmailContent("confirmation", data);

      expect(result.subject).toBe("Custom: Test Listing");
      expect(result.html).toBe("<b>Custom HTML for Jane Doe</b>");
      expect(result.text).toBe("Custom text for Jane Doe");
    });

    test("falls back to default on custom template render error", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "{{ invalid | nonexistent_filter }}",
      );
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      const errorSpy = spy(console, "error");
      try {
        const entries = [makeEntry()];
        const data = buildTemplateData(
          entries,
          "GBP",
          "https://example.com/t/ABC",
        );
        const result = await renderEmailContent("confirmation", data);

        // Should fall back to default subject
        expect(result.subject).toContain("Test Listing");
        // Should have logged the error
        const logs = map((c: { args: unknown[] }) => c.args[0] as string)(
          errorSpy.calls,
        );
        expect(
          logs.some(
            (l) =>
              l.includes("E_EMAIL_TEMPLATE_RENDER") &&
              l.includes("template render error"),
          ),
        ).toBe(true);
      } finally {
        errorSpy.restore();
      }
    });

    test("renders admin notification defaults correctly", async () => {
      const entries = [makeEntry()];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      const result = await renderEmailContent("admin", data);

      expect(result.subject).toContain("Jane Doe");
      expect(result.subject).toContain("Test Listing");
      expect(result.html).toContain("Jane Doe");
      expect(result.text).toContain("Name: Jane Doe");
    });

    test("renders admin notification with contact details", async () => {
      const entries = [
        makeEntry(
          {},
          {
            address: "123 Main St",
            phone: "555-1234",
            special_instructions: "Wheelchair",
          },
        ),
      ];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      const result = await renderEmailContent("admin", data);

      expect(result.text).toContain("Phone: 555-1234");
      expect(result.text).toContain("Address: 123 Main St");
      expect(result.text).toContain("Notes: Wheelchair");
    });

    test("omits empty contact fields in admin notification", async () => {
      const entries = [
        makeEntry({}, { address: "", phone: "", special_instructions: "" }),
      ];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      const result = await renderEmailContent("admin", data);

      expect(result.text).not.toContain("Phone:");
      expect(result.text).not.toContain("Address:");
      expect(result.text).not.toContain("Notes:");
    });

    test("renders paid listing with currency in confirmation", async () => {
      const entries = [
        makeEntry({ unit_price: 1000 }, { price_paid: "2000", quantity: 2 }),
      ];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      const result = await renderEmailContent("confirmation", data);

      expect(result.html).toContain("£20");
      expect(result.text).toContain("£20");
    });

    test("shows the amount owed when a balance is outstanding", async () => {
      // A provider-less booking: nothing collected, the full value owed.
      const entries = [
        makeEntry(
          { unit_price: 1000 },
          { price_paid: "0", remaining_balance: 2000 },
        ),
      ];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      const confirmation = await renderEmailContent("confirmation", data);
      const admin = await renderEmailContent("admin", data);

      expect(confirmation.html).toContain("Amount owed");
      expect(confirmation.html).toContain("£20");
      expect(confirmation.text).toContain("Amount owed: £20");
      expect(admin.html).toContain("Amount owed");
    });

    test("omits the amount owed when the booking is fully paid", async () => {
      const entries = [
        makeEntry(
          { unit_price: 1000 },
          { price_paid: "1000", remaining_balance: 0 },
        ),
      ];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      const result = await renderEmailContent("confirmation", data);

      expect(result.html).not.toContain("Amount owed");
      expect(result.text).not.toContain("Amount owed");
    });

    test("shows date when attendee has date", async () => {
      const entries = [makeEntry({}, { date: "2026-07-15" })];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );

      const result = await renderEmailContent("confirmation", data);

      expect(result.html).toContain("2026-07-15");
      expect(result.text).toContain("2026-07-15");
    });

    test("uses mix of custom and default parts", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "Custom Subject: {{ listing_names }}",
      );
      // html and text remain default
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      const entries = [makeEntry()];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );
      const result = await renderEmailContent("confirmation", data);

      expect(result.subject).toBe("Custom Subject: Test Listing");
      // html and text should still use defaults
      expect(result.html).toContain("Thanks for registering!");
      expect(result.text).toContain("Thanks for registering!");
    });

    test("logs non-Error thrown values as strings", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "Custom {{ listing_names }}",
      );
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      // Stub parseAndRender to throw a non-Error value on first call, then succeed
      let callCount = 0;
      const original = Liquid.prototype.parseAndRender;
      const parseAndRenderStub = stub(
        Liquid.prototype,
        "parseAndRender",
        function (
          this: InstanceType<typeof Liquid>,
          ...args: Parameters<typeof original>
        ) {
          if (callCount++ === 0) throw "string error value";
          return original.apply(this, args);
        },
      );
      const errorSpy = spy(console, "error");
      try {
        const entries = [makeEntry()];
        const data = buildTemplateData(
          entries,
          "GBP",
          "https://example.com/t/ABC",
        );
        await renderEmailContent("confirmation", data);

        const logs = map((c: { args: unknown[] }) => c.args[0] as string)(
          errorSpy.calls,
        );
        expect(logs.some((l) => l.includes("string error value"))).toBe(true);
      } finally {
        parseAndRenderStub.restore();
        errorSpy.restore();
      }
    });

    test("resets to defaults after clearing custom template", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "Custom Subject",
      );
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      await settings.update.email.template("confirmation", "subject", "");
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      const entries = [makeEntry()];
      const data = buildTemplateData(
        entries,
        "GBP",
        "https://example.com/t/ABC",
      );
      const result = await renderEmailContent("confirmation", data);

      expect(result.subject).toContain("Test Listing");
    });
  });

  describe("validateTemplate", () => {
    test("returns null for valid template", () => {
      expect(validateTemplate("Hello {{ name }}")).toBeNull();
    });

    test("returns null for template with for loop", () => {
      expect(
        validateTemplate("{% for x in items %}{{ x }}{% endfor %}"),
      ).toBeNull();
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
      const parseStub = stub(Liquid.prototype, "parse", () => {
        throw "raw string parse error";
      });
      try {
        const result = validateTemplate("anything");
        expect(result).toBe("raw string parse error");
      } finally {
        parseStub.restore();
      }
    });
  });
});
