/**
 * The Liquid filters and tags a custom email template can use.
 *
 * Driven through `renderEmailContent`, which is how the site really renders a
 * template the owner wrote: it reads their wording out of the settings, so
 * each test saves a template and reads back what would be sent. Rendering it
 * any other way would prove the engine works without proving the owner's
 * wording ever reaches it.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import {
  renderEmailContent,
  type TemplateData,
} from "#shared/email-renderer.ts";
import {
  describeEmailRenderer,
  sampleData,
  TICKET_URL,
} from "./test-helpers.ts";

/** Save one template as the owner's own wording, then read back the text the
 * site would send. The plain-text body, because it renders what it is given
 * without any markup of its own around it. */
const sendsWith = async (
  template: string,
  data: TemplateData = sampleData,
): Promise<string> => {
  await settings.update.email.template("confirmation", "text", template);
  // Dropping the cache is not enough: the renderer reads the loaded snapshot,
  // and an empty one falls back to the site's own wording.
  settings.invalidateCache();
  await settings.loadKeys(ALL_SETTINGS_KEYS);
  return (await renderEmailContent("confirmation", data)).text;
};

describeEmailRenderer(() => {
  describe("what a custom template can say", () => {
    test("renders simple variable interpolation", async () => {
      expect(await sendsWith("Hello {{ attendee.name }}")).toBe("Hello Jane");
    });

    test("renders listing_names variable", async () => {
      expect(await sendsWith("For {{ listing_names }}")).toBe("For Concert");
    });

    test("renders ticket_url variable", async () => {
      expect(await sendsWith("{{ ticket_url }}")).toBe(TICKET_URL);
    });

    test("renders currency filter", async () => {
      expect(await sendsWith("{{ 2000 | currency }}")).toBe("£20");
    });

    test("renders currency filter with string value", async () => {
      expect(
        await sendsWith(
          "{% for entry in entries %}{{ entry.attendee.price_paid | currency }}{% endfor %}",
        ),
      ).toBe("£20");
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
      expect(
        await sendsWith(
          '{% for entry in entries %}{{ entry.attendee.quantity }} {{ entry.attendee.quantity | pluralize: "ticket", "tickets" }}{% endfor %}',
          data,
        ),
      ).toBe("1 ticket");
    });

    test("renders pluralize filter for plural", async () => {
      expect(
        await sendsWith(
          '{% for entry in entries %}{{ entry.attendee.quantity }} {{ entry.attendee.quantity | pluralize: "ticket", "tickets" }}{% endfor %}',
        ),
      ).toBe("2 tickets");
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
      expect(
        await sendsWith(
          "{% for entry in entries %}{{ entry.listing.name }} {% endfor %}",
          data,
        ),
      ).toBe("Listing A Listing B");
    });

    test("renders conditional on is_paid", async () => {
      expect(
        await sendsWith(
          "{% for entry in entries %}{% if entry.listing.is_paid %}paid{% else %}free{% endif %}{% endfor %}",
        ),
      ).toBe("paid");
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
      expect(
        await sendsWith(
          "{% for entry in entries %}{% if entry.attendee.date %}{{ entry.attendee.date }}{% endif %}{% endfor %}",
          data,
        ),
      ).toBe("2026-04-15");
    });

    test("trims whitespace from rendered output", async () => {
      expect(await sendsWith("  hello  ")).toBe("hello");
    });
  });
});
