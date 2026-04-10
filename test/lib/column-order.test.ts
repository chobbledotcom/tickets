import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildDefaultTemplate,
  renderFilteredValue,
  resolveColumnLayout,
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

  test("accepts templates with filters", () => {
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

  test("extracts filter expressions", () => {
    const { columnKeys, filters } = resolveColumnLayout(
      '{{name}}, {{created | date: "%B %d"}}',
      VALID_EVENT_KEYS,
      EVENT_DEFAULT_ORDER,
    );
    expect(columnKeys).toEqual(["name", "created"]);
    expect(filters.get("created")).toBe('created | date: "%B %d"');
    expect(filters.has("name")).toBe(false);
  });

  test("works with all attendee columns", () => {
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

describe("buildDefaultTemplate", () => {
  test("builds template from ordered keys", () => {
    expect(buildDefaultTemplate(["name", "status"])).toBe(
      "{{name}}, {{status}}",
    );
  });

  test("builds event default template", () => {
    expect(buildDefaultTemplate(EVENT_DEFAULT_ORDER)).toBe(
      "{{name}}, {{description}}, {{status}}, {{attendees}}, {{created}}",
    );
  });
});

describe("EVENT_TABLE_COLUMNS", () => {
  test("has all default order keys", () => {
    for (const key of EVENT_DEFAULT_ORDER) {
      expect(EVENT_TABLE_COLUMNS[key]).toBeDefined();
    }
  });

  test("every column has label, description, and cell", () => {
    for (const [_key, col] of Object.entries(EVENT_TABLE_COLUMNS)) {
      expect(col.label.length).toBeGreaterThan(0);
      expect(col.description.length).toBeGreaterThan(0);
      expect(typeof col.cell).toBe("function");
    }
  });
});

describe("ATTENDEE_TABLE_COLUMNS", () => {
  test("has all default order keys", () => {
    for (const key of ATTENDEE_DEFAULT_ORDER) {
      expect(ATTENDEE_TABLE_COLUMNS[key]).toBeDefined();
    }
  });

  test("every column has label, description, and cell", () => {
    for (const [_key, col] of Object.entries(ATTENDEE_TABLE_COLUMNS)) {
      expect(col.label.length).toBeGreaterThan(0);
      expect(col.description.length).toBeGreaterThan(0);
      expect(typeof col.cell).toBe("function");
    }
  });
});

describe("EVENT_TABLE_COLUMNS cell renderers", () => {
  // Event columns have TOpts=unknown, so we pass undefined
  const u = undefined as unknown;

  test("date column renders formatted date or empty string", () => {
    const col = EVENT_TABLE_COLUMNS.date!;
    expect(
      col.cell(testEventWithCount({ date: "2026-04-10T19:00:00Z" }), u),
    ).toContain("2026");
    expect(col.cell(testEventWithCount({ date: "" }), u)).toBe("");
    expect(col.rawValue!(testEventWithCount({ date: "2026-04-10" }), u)).toBe(
      "2026-04-10",
    );
    expect(col.rawValue!(testEventWithCount({ date: "" }), u)).toBe("");
  });

  test("location column renders event location", () => {
    const col = EVENT_TABLE_COLUMNS.location!;
    expect(col.cell(testEventWithCount({ location: "Town Hall" }), u)).toBe(
      "Town Hall",
    );
  });

  test("price column renders price or Free", () => {
    const col = EVENT_TABLE_COLUMNS.price!;
    expect(col.cell(testEventWithCount({ unit_price: 2500 }), u)).toBe("2500");
    expect(col.cell(testEventWithCount({ unit_price: 0 }), u)).toBe("Free");
    expect(col.rawValue!(testEventWithCount({ unit_price: 2500 }), u)).toBe(
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

  test("name column renders attendee name", () => {
    const col = ATTENDEE_TABLE_COLUMNS.name!;
    expect(
      col.cell(makeRow({ attendee: testAttendee({ name: "Alice" }) }), opts),
    ).toBe("Alice");
  });

  test("event column renders linked event name", () => {
    const col = ATTENDEE_TABLE_COLUMNS.event!;
    const html = col.cell(makeRow({ eventName: "Gala", eventId: 42 }), opts);
    expect(html).toContain("/admin/event/42");
    expect(html).toContain("Gala");
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
    expect(
      col.cell(
        makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
        opts,
      ),
    ).toContain("tel:");
    expect(
      col.cell(makeRow({ attendee: testAttendee({ phone: "" }) }), opts),
    ).toBe("");
  });

  test("phone column defaults to prefix 44 when phonePrefix is empty", () => {
    const col = ATTENDEE_TABLE_COLUMNS.phone!;
    const html = col.cell(
      makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
      { ...opts, phonePrefix: "" },
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
