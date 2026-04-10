import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildDefaultTemplate,
  type ColumnGenerators,
  getOrderedColumns,
  parseColumnTemplate,
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
    expect(result).toEqual({
      ok: true,
      columns: ["name", "description", "status"],
    });
  });

  test("handles wonky spacing", () => {
    const result = parseColumnTemplate(
      "{{ name }},{{description}},  {{ status  }}",
      VALID_EVENT_KEYS,
    );
    expect(result).toEqual({
      ok: true,
      columns: ["name", "description", "status"],
    });
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
    expect(result).toEqual({ ok: true, columns: ["name", "status"] });
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
    expect(result).toEqual({
      ok: true,
      columns: ["name", "qty", "registered"],
    });
  });

  test("ignores Liquid filters during validation", () => {
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

describe("getOrderedColumns", () => {
  type TestRow = { val: string };
  const generators: ColumnGenerators<TestRow> = {
    a: {
      label: "A",
      description: "Column A",
      header: () => "A",
      cell: (r) => r.val,
    },
    b: {
      label: "B",
      description: "Column B",
      header: () => "B",
      cell: (r) => r.val,
    },
    c: {
      label: "C",
      description: "Column C",
      header: () => "C",
      cell: (r) => r.val,
    },
  };

  test("returns columns in template order", () => {
    const cols = getOrderedColumns("{{c}}, {{a}}", generators, ["a", "b", "c"]);
    expect(cols.map((c) => c.label)).toEqual(["C", "A"]);
  });

  test("falls back to default order when template is empty", () => {
    const cols = getOrderedColumns("", generators, ["a", "b", "c"]);
    expect(cols.map((c) => c.label)).toEqual(["A", "B", "C"]);
  });

  test("falls back to default order when template is invalid", () => {
    const cols = getOrderedColumns("{{unknown}}", generators, ["a", "b", "c"]);
    expect(cols.map((c) => c.label)).toEqual(["A", "B", "C"]);
  });

  test("skips generator keys that do not exist", () => {
    const cols = getOrderedColumns("{{a}}, {{b}}", generators, ["a"]);
    expect(cols.map((c) => c.label)).toEqual(["A", "B"]);
  });

  test("returns empty array when template references no valid generators", () => {
    const empty: ColumnGenerators<TestRow> = {};
    const cols = getOrderedColumns("", empty, []);
    expect(cols).toEqual([]);
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
