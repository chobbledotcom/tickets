import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { TemplateData } from "#shared/email-renderer.ts";
import { renderTemplate } from "#shared/email-renderer.ts";
import {
  describeEmailRenderer,
  sampleData,
  TICKET_URL,
} from "./test-helpers.ts";

describeEmailRenderer(() => {
  describe("renderTemplate", () => {
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
      expect(result).toBe(TICKET_URL);
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
});
