import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ColumnGenerators } from "#shared/column-order.ts";
import {
  buildDefaultTemplate,
  getHeaderText,
  renderCells,
  renderFilteredValue,
  resolveColumnLayout,
  validateColumnTemplate,
} from "#shared/column-order.ts";
import {
  ATTENDEE_DEFAULT_ORDER,
  ATTENDEE_TABLE_COLUMNS,
} from "#shared/columns/attendee-columns.ts";
import {
  EVENT_DEFAULT_ORDER,
  EVENT_TABLE_COLUMNS,
} from "#shared/columns/event-columns.ts";
import { escapeHtml } from "#templates/layout.tsx";
import { setupTestEncryptionKey, testEventWithCount } from "#test-utils";

setupTestEncryptionKey();

const VALID_EVENT_KEYS = Object.keys(EVENT_TABLE_COLUMNS);
const VALID_ATTENDEE_KEYS = Object.keys(ATTENDEE_TABLE_COLUMNS);

describe("validateColumnTemplate", () => {
  test("returns null for valid template", () => {
    expect(
      validateColumnTemplate("{{name}}, {{status}}", VALID_EVENT_KEYS),
    ).toBeNull();
  });

  test("handles wonky spacing", () => {
    expect(
      validateColumnTemplate(
        "{{ name }},{{description}},  {{ status  }}",
        VALID_EVENT_KEYS,
      ),
    ).toBeNull();
  });

  test("rejects unknown column (typo)", () => {
    const error = validateColumnTemplate(
      "{{name}}, {{descritpion}}",
      VALID_EVENT_KEYS,
    );
    expect(error).toContain("descritpion");
    expect(error).toContain("Available columns");
  });

  test("rejects empty template", () => {
    const error = validateColumnTemplate("", VALID_EVENT_KEYS);
    expect(error).toContain("at least one column");
  });

  test("accepts templates with date filter", () => {
    expect(
      validateColumnTemplate(
        '{{name}}, {{created | date: "%B"}}',
        VALID_EVENT_KEYS,
      ),
    ).toBeNull();
  });

  test("accepts templates with currency filter", () => {
    expect(
      validateColumnTemplate(
        "{{name}}, {{price | currency}}",
        VALID_EVENT_KEYS,
      ),
    ).toBeNull();
  });
});

describe("resolveColumnLayout", () => {
  test("returns default order when template is empty", () => {
    const { columnKeys, filters } = resolveColumnLayout(
      "",
      VALID_EVENT_KEYS,
      EVENT_DEFAULT_ORDER,
    );
    expect(columnKeys).toEqual([...EVENT_DEFAULT_ORDER]);
    expect(filters.size).toBe(0);
  });

  test("returns columns in template order", () => {
    const { columnKeys } = resolveColumnLayout(
      "{{status}}, {{name}}",
      VALID_EVENT_KEYS,
      EVENT_DEFAULT_ORDER,
    );
    expect(columnKeys).toEqual(["status", "name"]);
  });

  test("deduplicates repeated columns", () => {
    const { columnKeys } = resolveColumnLayout(
      "{{name}}, {{name}}, {{status}}",
      VALID_EVENT_KEYS,
      EVENT_DEFAULT_ORDER,
    );
    expect(columnKeys).toEqual(["name", "status"]);
  });

  test("falls back to default for invalid template", () => {
    const { columnKeys } = resolveColumnLayout(
      "{{bogus}}",
      VALID_EVENT_KEYS,
      EVENT_DEFAULT_ORDER,
    );
    expect(columnKeys).toEqual([...EVENT_DEFAULT_ORDER]);
  });

  test("extracts filter expression for filtered column", () => {
    const { filters } = resolveColumnLayout(
      '{{name}}, {{created | date: "%B %d"}}',
      VALID_EVENT_KEYS,
      EVENT_DEFAULT_ORDER,
    );
    expect(filters.get("created")).toBe('created | date: "%B %d"');
  });

  test("does not create filter entry for unfiltered column", () => {
    const { filters } = resolveColumnLayout(
      '{{name}}, {{created | date: "%B %d"}}',
      VALID_EVENT_KEYS,
      EVENT_DEFAULT_ORDER,
    );
    expect(filters.has("name")).toBe(false);
  });

  test("resolves all attendee columns from default template", () => {
    const template = buildDefaultTemplate(ATTENDEE_DEFAULT_ORDER);
    const { columnKeys } = resolveColumnLayout(
      template,
      VALID_ATTENDEE_KEYS,
      ATTENDEE_DEFAULT_ORDER,
    );
    expect(columnKeys).toEqual([...ATTENDEE_DEFAULT_ORDER]);
  });
});

describe("renderFilteredValue", () => {
  test("applies date filter with strftime format", () => {
    const result = renderFilteredValue(
      'created | date: "%B %d, %Y"',
      "2026-04-10T19:00:00Z",
      "created",
    );
    expect(result).toContain("April");
    expect(result).toContain("2026");
  });

  test("applies date filter with short format", () => {
    const result = renderFilteredValue(
      'date | date: "%d/%m/%Y"',
      "2026-03-15",
      "date",
    );
    expect(result).toBe("15/03/2026");
  });

  test("applies currency filter", () => {
    const result = renderFilteredValue("price | currency", 2500, "price");
    expect(result).toContain("25");
  });

  test("returns empty string for falsy date value", () => {
    expect(renderFilteredValue('date | date: "%B"', "", "date")).toBe("");
  });

  test("passes through unparseable date string", () => {
    expect(renderFilteredValue('date | date: "%B"', "not-a-date", "date")).toBe(
      "not-a-date",
    );
  });

  test("renders value without filter when no pipe", () => {
    expect(renderFilteredValue("name", "Alice", "name")).toBe("Alice");
  });
});

describe("renderCells", () => {
  test("renders event columns end-to-end through the full pipeline", () => {
    const event = testEventWithCount({
      date: "2026-06-15",
      name: "Jazz Night",
      unit_price: 0,
    });
    const { columnKeys, filters } = resolveColumnLayout(
      "{{name}}, {{price}}, {{date}}",
      VALID_EVENT_KEYS,
      EVENT_DEFAULT_ORDER,
    );
    const html = renderCells(
      event,
      columnKeys,
      EVENT_TABLE_COLUMNS,
      undefined as unknown,
      filters,
      escapeHtml,
    );
    expect(html).toContain("Jazz Night");
    expect(html).toContain("Free");
    expect(html).toContain("<td>");
  });

  test("applies Liquid filters when template uses them", () => {
    const event = testEventWithCount({
      created: "2026-01-10T09:00:00Z",
      date: "2026-03-15",
      unit_price: 2500,
    });
    const { columnKeys, filters } = resolveColumnLayout(
      '{{date | date: "%d/%m/%Y"}}, {{created | date: "%B %Y"}}, {{price | currency}}',
      VALID_EVENT_KEYS,
      EVENT_DEFAULT_ORDER,
    );
    const html = renderCells(
      event,
      columnKeys,
      EVENT_TABLE_COLUMNS,
      undefined as unknown,
      filters,
      escapeHtml,
    );
    expect(html).toContain("15/03/2026");
    expect(html).toContain("January 2026");
    expect(html).toContain("25");
  });

  test("escapes HTML in plain text cells to prevent XSS", () => {
    const event = testEventWithCount({
      location: '<script>alert("xss")</script>',
    });
    const { columnKeys, filters } = resolveColumnLayout(
      "{{location}}",
      VALID_EVENT_KEYS,
      EVENT_DEFAULT_ORDER,
    );
    const html = renderCells(
      event,
      columnKeys,
      EVENT_TABLE_COLUMNS,
      undefined as unknown,
      filters,
      escapeHtml,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("applies CSS class from column definition", () => {
    const generators: ColumnGenerators<{ val: string }> = {
      val: {
        cell: (r) => r.val,
        className: "custom-class",
        description: "test",
        label: "Val",
      },
    };
    const html = renderCells(
      { val: "hi" },
      ["val"],
      generators,
      undefined,
      new Map(),
      escapeHtml,
    );
    expect(html).toContain('class="custom-class"');
  });
});

describe("getHeaderText", () => {
  test("returns headerText when set", () => {
    expect(getHeaderText(EVENT_TABLE_COLUMNS.name!)).toBe("Event Name");
  });

  test("falls back to label when headerText is not set", () => {
    expect(getHeaderText(EVENT_TABLE_COLUMNS.location!)).toBe("Location");
  });
});
