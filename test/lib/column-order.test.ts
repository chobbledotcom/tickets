import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildDefaultTemplate,
  parseColumnTemplate,
  renderFilteredValue,
  validateColumnTemplate,
} from "#lib/column-order.ts";
import {
  ATTENDEE_DEFAULT_ORDER,
  ATTENDEE_TABLE_COLUMNS,
} from "#lib/columns/attendee-columns.ts";
import {
  EVENT_DEFAULT_ORDER,
  EVENT_TABLE_COLUMNS,
} from "#lib/columns/event-columns.ts";
import type { AttendeeTableRow } from "#lib/types.ts";
import {
  setupTestEncryptionKey,
  testAttendee,
  testEventWithCount,
} from "#test-utils";

setupTestEncryptionKey();

const VALID_EVENT_KEYS = Object.keys(EVENT_TABLE_COLUMNS);
const VALID_ATTENDEE_KEYS = Object.keys(ATTENDEE_TABLE_COLUMNS);

describe("parseColumnTemplate", () => {
  test("parses a simple template with valid columns", () => {
    const result = parseColumnTemplate(
      "{{name}}, {{description}}, {{status}}",
      VALID_EVENT_KEYS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns).toEqual(["name", "description", "status"]);
      expect(result.filters.size).toBe(0);
    }
  });

  test("handles wonky spacing", () => {
    const result = parseColumnTemplate(
      "{{ name }},{{description}},  {{ status  }}",
      VALID_EVENT_KEYS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns).toEqual(["name", "description", "status"]);
    }
  });

  test("returns error for unknown column (typo)", () => {
    const result = parseColumnTemplate(
      "{{name}}, {{descritpion}}",
      VALID_EVENT_KEYS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("descritpion");
      expect(result.error).toContain("Available columns");
    }
  });

  test("returns error for invalid Liquid syntax", () => {
    const result = parseColumnTemplate(
      "{{name}, {{description}}",
      VALID_EVENT_KEYS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid template");
    }
  });

  test("returns error for empty template (no columns)", () => {
    const result = parseColumnTemplate("", VALID_EVENT_KEYS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("at least one column");
    }
  });

  test("deduplicates repeated columns", () => {
    const result = parseColumnTemplate(
      "{{name}}, {{name}}, {{status}}",
      VALID_EVENT_KEYS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns).toEqual(["name", "status"]);
    }
  });

  test("works with all event columns", () => {
    const template = buildDefaultTemplate(EVENT_DEFAULT_ORDER);
    const result = parseColumnTemplate(template, VALID_EVENT_KEYS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns).toEqual([...EVENT_DEFAULT_ORDER]);
    }
  });

  test("works with all attendee columns", () => {
    const template = buildDefaultTemplate(ATTENDEE_DEFAULT_ORDER);
    const result = parseColumnTemplate(template, VALID_ATTENDEE_KEYS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns).toEqual([...ATTENDEE_DEFAULT_ORDER]);
    }
  });

  test("handles subset of columns", () => {
    const result = parseColumnTemplate(
      "{{name}}, {{qty}}, {{registered}}",
      VALID_ATTENDEE_KEYS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns).toEqual(["name", "qty", "registered"]);
      expect(result.filters.size).toBe(0);
    }
  });

  test("extracts filter expressions from columns with pipes", () => {
    const result = parseColumnTemplate(
      '{{name}}, {{created | date: "%B %d"}}, {{status}}',
      VALID_EVENT_KEYS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns).toEqual(["name", "created", "status"]);
      expect(result.filters.size).toBe(1);
      expect(result.filters.get("created")).toBe('created | date: "%B %d"');
      expect(result.filters.has("name")).toBe(false);
    }
  });

  test("validates templates with currency filter", () => {
    const result = parseColumnTemplate(
      "{{name}}, {{price | currency}}",
      VALID_EVENT_KEYS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns).toEqual(["name", "price"]);
      expect(result.filters.get("price")).toBe("price | currency");
    }
  });

  test("validates Liquid filters without rejecting them", () => {
    const result = parseColumnTemplate(
      "{{name | date: '%B'}}, {{status}}",
      VALID_EVENT_KEYS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns).toEqual(["name", "status"]);
    }
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
    // formatCurrency formats in configured currency (GBP default)
    expect(result).toContain("25");
  });

  test("returns empty string for falsy value with date filter", () => {
    const result = renderFilteredValue('date | date: "%B"', "", "date");
    expect(result).toBe("");
  });

  test("returns original value for unparseable date", () => {
    const result = renderFilteredValue(
      'date | date: "%B"',
      "not-a-date",
      "date",
    );
    expect(result).toBe("not-a-date");
  });

  test("date filter without format returns toLocaleDateString", () => {
    const result = renderFilteredValue(
      "created | date",
      "2026-04-10T19:00:00Z",
      "created",
    );
    expect(result.length).toBeGreaterThan(0);
  });

  test("strftime handles all common format codes", () => {
    // Use a known date: Thursday April 10, 2026 at 14:05:09
    const iso = "2026-04-10T14:05:09Z";
    expect(renderFilteredValue('d | date: "%Y"', iso, "d")).toBe("2026");
    expect(renderFilteredValue('d | date: "%y"', iso, "d")).toBe("26");
    expect(renderFilteredValue('d | date: "%m"', iso, "d")).toBe("04");
    expect(renderFilteredValue('d | date: "%d"', iso, "d")).toBe("10");
    expect(renderFilteredValue('d | date: "%e"', iso, "d")).toBe("10");
    expect(renderFilteredValue('d | date: "%H"', iso, "d")).toBe("14");
    expect(renderFilteredValue('d | date: "%M"', iso, "d")).toBe("05");
    expect(renderFilteredValue('d | date: "%S"', iso, "d")).toBe("09");
    expect(renderFilteredValue('d | date: "%B"', iso, "d")).toBe("April");
    expect(renderFilteredValue('d | date: "%b"', iso, "d")).toBe("Apr");
    expect(renderFilteredValue('d | date: "%A"', iso, "d")).toBe("Friday");
    expect(renderFilteredValue('d | date: "%a"', iso, "d")).toBe("Fri");
    expect(renderFilteredValue('d | date: "%p"', iso, "d")).toBe("PM");
    expect(renderFilteredValue('d | date: "%I"', iso, "d")).toBe("02");
    expect(renderFilteredValue('d | date: "%%"', iso, "d")).toBe("%");
    expect(renderFilteredValue('d | date: "%Z"', iso, "d")).toBe("%Z");
  });

  test("strftime handles AM for morning hours", () => {
    const am = "2026-04-10T09:00:00Z";
    expect(renderFilteredValue('d | date: "%p"', am, "d")).toBe("AM");
    expect(renderFilteredValue('d | date: "%I"', am, "d")).toBe("09");
  });

  test("strftime handles midnight (12 AM)", () => {
    const midnight = "2026-04-10T00:00:00Z";
    expect(renderFilteredValue('d | date: "%I"', midnight, "d")).toBe("12");
  });

  test("renders value without filter when no pipe", () => {
    const result = renderFilteredValue("name", "Alice", "name");
    expect(result).toBe("Alice");
  });
});

describe("validateColumnTemplate", () => {
  test("returns null for valid template", () => {
    const error = validateColumnTemplate(
      "{{name}}, {{status}}",
      VALID_EVENT_KEYS,
    );
    expect(error).toBeNull();
  });

  test("returns error string for invalid template", () => {
    const error = validateColumnTemplate("{{naem}}", VALID_EVENT_KEYS);
    expect(error).not.toBeNull();
    expect(error).toContain("naem");
  });
});

describe("buildDefaultTemplate", () => {
  test("builds template from ordered keys", () => {
    expect(buildDefaultTemplate(["name", "status"])).toBe(
      "{{name}}, {{status}}",
    );
  });

  test("builds event default template", () => {
    const template = buildDefaultTemplate(EVENT_DEFAULT_ORDER);
    expect(template).toBe(
      "{{name}}, {{description}}, {{status}}, {{attendees}}, {{created}}",
    );
  });

  test("builds attendee default template", () => {
    const template = buildDefaultTemplate(ATTENDEE_DEFAULT_ORDER);
    expect(template).toContain("{{name}}");
    expect(template).toContain("{{status}}");
    expect(template).toContain("{{actions}}");
  });
});

describe("EVENT_TABLE_COLUMNS", () => {
  test("has all default order keys", () => {
    for (const key of EVENT_DEFAULT_ORDER) {
      expect(EVENT_TABLE_COLUMNS[key]).toBeDefined();
    }
  });

  test("every column has label, description, header, and cell", () => {
    for (const [_key, col] of Object.entries(EVENT_TABLE_COLUMNS)) {
      expect(typeof col.label).toBe("string");
      expect(typeof col.description).toBe("string");
      expect(typeof col.header).toBe("function");
      expect(typeof col.cell).toBe("function");
      expect(col.label.length).toBeGreaterThan(0);
      expect(col.description.length).toBeGreaterThan(0);
      // header returns a string
      expect(typeof col.header()).toBe("string");
    }
  });
});

describe("ATTENDEE_TABLE_COLUMNS", () => {
  test("has all default order keys", () => {
    for (const key of ATTENDEE_DEFAULT_ORDER) {
      expect(ATTENDEE_TABLE_COLUMNS[key]).toBeDefined();
    }
  });

  test("every column has label, description, header, and cell", () => {
    for (const [_key, col] of Object.entries(ATTENDEE_TABLE_COLUMNS)) {
      expect(typeof col.label).toBe("string");
      expect(typeof col.description).toBe("string");
      expect(typeof col.header).toBe("function");
      expect(typeof col.cell).toBe("function");
      expect(col.label.length).toBeGreaterThan(0);
      expect(col.description.length).toBeGreaterThan(0);
    }
  });
});

describe("EVENT_TABLE_COLUMNS cell renderers", () => {
  const opts = {} as Record<string, never>;

  test("date column renders formatted date or empty string", () => {
    const col = EVENT_TABLE_COLUMNS.date!;
    expect(
      col.cell(testEventWithCount({ date: "2026-04-10T19:00:00Z" }), opts),
    ).toContain("2026");
    expect(col.cell(testEventWithCount({ date: "" }), opts)).toBe("");
    expect(
      col.rawValue!(testEventWithCount({ date: "2026-04-10" }), opts),
    ).toBe("2026-04-10");
    expect(col.rawValue!(testEventWithCount({ date: "" }), opts)).toBe("");
  });

  test("location column renders event location", () => {
    const col = EVENT_TABLE_COLUMNS.location!;
    expect(col.cell(testEventWithCount({ location: "Town Hall" }), opts)).toBe(
      "Town Hall",
    );
  });

  test("price column renders price or Free", () => {
    const col = EVENT_TABLE_COLUMNS.price!;
    expect(col.cell(testEventWithCount({ unit_price: 2500 }), opts)).toBe(
      "2500",
    );
    expect(col.cell(testEventWithCount({ unit_price: 0 }), opts)).toBe("Free");
    expect(col.rawValue!(testEventWithCount({ unit_price: 2500 }), opts)).toBe(
      2500,
    );
  });
});

describe("ATTENDEE_TABLE_COLUMNS cell renderers", () => {
  const opts: import("#templates/attendee-table.tsx").AttendeeColumnOpts = {
    allowedDomain: "example.com",
    phonePrefix: "44",
    renderStatus: () => "",
    renderActions: () => "",
    answerTextMap: new Map(),
    answerQuestionMap: new Map(),
  };
  const makeRow = (
    overrides: Partial<AttendeeTableRow> = {},
  ): AttendeeTableRow => ({
    attendee: testAttendee(),
    eventId: 1,
    eventName: "Test Event",
    ...overrides,
  });

  test("name column renders escaped attendee name", () => {
    const col = ATTENDEE_TABLE_COLUMNS.name!;
    expect(
      col.cell(makeRow({ attendee: testAttendee({ name: "Alice" }) }), opts),
    ).toBe("Alice");
  });

  test("event column renders linked event name", () => {
    const col = ATTENDEE_TABLE_COLUMNS.event!;
    expect(
      col.cell(makeRow({ eventName: "Gala", eventId: 42 }), opts),
    ).toContain("/admin/event/42");
    expect(
      col.cell(makeRow({ eventName: "Gala", eventId: 42 }), opts),
    ).toContain("Gala");
  });

  test("date column renders formatted date or empty", () => {
    const col = ATTENDEE_TABLE_COLUMNS.date!;
    expect(
      col.cell(
        makeRow({ attendee: testAttendee({ date: "2026-03-15" }) }),
        opts,
      ),
    ).toContain("March");
    expect(
      col.cell(makeRow({ attendee: testAttendee({ date: null }) }), opts),
    ).toBe("");
    expect(
      col.rawValue!(
        makeRow({ attendee: testAttendee({ date: "2026-03-15" }) }),
        opts,
      ),
    ).toBe("2026-03-15");
    expect(
      col.rawValue!(makeRow({ attendee: testAttendee({ date: null }) }), opts),
    ).toBe("");
  });

  test("email column renders email or empty", () => {
    const col = ATTENDEE_TABLE_COLUMNS.email!;
    expect(
      col.cell(makeRow({ attendee: testAttendee({ email: "a@b.com" }) }), opts),
    ).toBe("a@b.com");
    expect(
      col.cell(makeRow({ attendee: testAttendee({ email: "" }) }), opts),
    ).toBe("");
  });

  test("phone column renders tel link or empty", () => {
    const col = ATTENDEE_TABLE_COLUMNS.phone!;
    const html = col.cell(
      makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
      opts,
    );
    expect(html).toContain("tel:");
    expect(
      col.cell(makeRow({ attendee: testAttendee({ phone: "" }) }), opts),
    ).toBe("");
  });

  test("phone column defaults to prefix 44 when phonePrefix is empty", () => {
    const col = ATTENDEE_TABLE_COLUMNS.phone!;
    const noPrefix = { ...opts, phonePrefix: "" };
    const html = col.cell(
      makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
      noPrefix,
    );
    expect(html).toContain("tel:+447700900000");
  });

  test("address column renders inline address", () => {
    const col = ATTENDEE_TABLE_COLUMNS.address!;
    expect(
      col.cell(
        makeRow({ attendee: testAttendee({ address: "123 Main\nNew York" }) }),
        opts,
      ),
    ).toContain("123 Main");
  });

  test("special_instructions column renders inline or empty", () => {
    const col = ATTENDEE_TABLE_COLUMNS.special_instructions!;
    expect(
      col.cell(
        makeRow({
          attendee: testAttendee({ special_instructions: "VIP\nfront row" }),
        }),
        opts,
      ),
    ).toContain("VIP");
    expect(
      col.cell(
        makeRow({ attendee: testAttendee({ special_instructions: "" }) }),
        opts,
      ),
    ).toBe("");
  });

  test("qty column renders quantity", () => {
    const col = ATTENDEE_TABLE_COLUMNS.qty!;
    expect(
      col.cell(makeRow({ attendee: testAttendee({ quantity: 3 }) }), opts),
    ).toBe("3");
  });

  test("ticket column renders token link", () => {
    const col = ATTENDEE_TABLE_COLUMNS.ticket!;
    const html = col.cell(
      makeRow({ attendee: testAttendee({ ticket_token: "abc123" }) }),
      opts,
    );
    expect(html).toContain("example.com/t/abc123");
    expect(html).toContain("abc123");
  });

  test("registered column renders formatted datetime", () => {
    const col = ATTENDEE_TABLE_COLUMNS.registered!;
    expect(
      col.cell(
        makeRow({
          attendee: testAttendee({ created: "2026-01-01T12:00:00Z" }),
        }),
        opts,
      ),
    ).toContain("2026");
  });
});
