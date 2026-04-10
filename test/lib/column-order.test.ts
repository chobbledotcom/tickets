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

describe("buildDefaultTemplate", () => {
  test("builds template from ordered keys", () => {
    expect(buildDefaultTemplate(["name", "status"])).toBe(
      "{{name}}, {{status}}",
    );
  });

  test("includes all default event columns", () => {
    const template = buildDefaultTemplate(EVENT_DEFAULT_ORDER);
    for (const key of EVENT_DEFAULT_ORDER) {
      expect(template).toContain(`{{${key}}}`);
    }
  });
});

describe("EVENT_TABLE_COLUMNS", () => {
  test("has all default order keys", () => {
    for (const key of EVENT_DEFAULT_ORDER) {
      expect(EVENT_TABLE_COLUMNS[key]).toBeDefined();
    }
  });
});

describe("ATTENDEE_TABLE_COLUMNS", () => {
  test("has all default order keys", () => {
    for (const key of ATTENDEE_DEFAULT_ORDER) {
      expect(ATTENDEE_TABLE_COLUMNS[key]).toBeDefined();
    }
  });
});

describe("EVENT_TABLE_COLUMNS cell renderers", () => {
  // Event columns have TOpts=unknown, so we pass undefined
  const u = undefined as unknown;

  test("date cell renders formatted date", () => {
    const col = EVENT_TABLE_COLUMNS.date!;
    expect(
      col.cell(testEventWithCount({ date: "2026-04-10T19:00:00Z" }), u),
    ).toContain("2026");
  });

  test("date cell renders empty for missing date", () => {
    const col = EVENT_TABLE_COLUMNS.date!;
    expect(col.cell(testEventWithCount({ date: "" }), u)).toBe("");
  });

  test("date rawValue returns ISO string", () => {
    const col = EVENT_TABLE_COLUMNS.date!;
    expect(col.rawValue!(testEventWithCount({ date: "2026-04-10" }), u)).toBe(
      "2026-04-10",
    );
  });

  test("date rawValue returns empty for missing date", () => {
    const col = EVENT_TABLE_COLUMNS.date!;
    expect(col.rawValue!(testEventWithCount({ date: "" }), u)).toBe("");
  });

  test("location cell renders event location", () => {
    expect(
      EVENT_TABLE_COLUMNS.location!.cell(
        testEventWithCount({ location: "Town Hall" }),
        u,
      ),
    ).toBe("Town Hall");
  });

  test("price cell renders numeric price", () => {
    expect(
      EVENT_TABLE_COLUMNS.price!.cell(
        testEventWithCount({ unit_price: 2500 }),
        u,
      ),
    ).toBe("2500");
  });

  test("price cell renders Free for zero price", () => {
    expect(
      EVENT_TABLE_COLUMNS.price!.cell(testEventWithCount({ unit_price: 0 }), u),
    ).toBe("Free");
  });

  test("price rawValue returns raw number", () => {
    expect(
      EVENT_TABLE_COLUMNS.price!.rawValue!(
        testEventWithCount({ unit_price: 2500 }),
        u,
      ),
    ).toBe(2500);
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

  test("name cell renders attendee name", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.name!.cell(
        makeRow({ attendee: testAttendee({ name: "Alice" }) }),
        opts,
      ),
    ).toBe("Alice");
  });

  test("event cell renders linked event name", () => {
    const html = ATTENDEE_TABLE_COLUMNS.event!.cell(
      makeRow({ eventName: "Gala", eventId: 42 }),
      opts,
    );
    expect(html).toContain("/admin/event/42");
    expect(html).toContain("Gala");
  });

  test("date cell renders formatted date", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.date!.cell(
        makeRow({ attendee: testAttendee({ date: "2026-03-15" }) }),
        opts,
      ),
    ).toContain("March");
  });

  test("date cell renders empty for null date", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.date!.cell(
        makeRow({ attendee: testAttendee({ date: null }) }),
        opts,
      ),
    ).toBe("");
  });

  test("date rawValue returns date string", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.date!.rawValue!(
        makeRow({ attendee: testAttendee({ date: "2026-03-15" }) }),
        opts,
      ),
    ).toBe("2026-03-15");
  });

  test("date rawValue returns empty for null date", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.date!.rawValue!(
        makeRow({ attendee: testAttendee({ date: null }) }),
        opts,
      ),
    ).toBe("");
  });

  test("email cell renders email address", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.email!.cell(
        makeRow({ attendee: testAttendee({ email: "a@b.com" }) }),
        opts,
      ),
    ).toBe("a@b.com");
  });

  test("email cell renders empty when not provided", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.email!.cell(
        makeRow({ attendee: testAttendee({ email: "" }) }),
        opts,
      ),
    ).toBe("");
  });

  test("phone cell renders tel link", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.phone!.cell(
        makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
        opts,
      ),
    ).toContain("tel:");
  });

  test("phone cell renders empty when not provided", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.phone!.cell(
        makeRow({ attendee: testAttendee({ phone: "" }) }),
        opts,
      ),
    ).toBe("");
  });

  test("phone cell defaults to prefix 44 when phonePrefix is empty", () => {
    const html = ATTENDEE_TABLE_COLUMNS.phone!.cell(
      makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
      { ...opts, phonePrefix: "" },
    );
    expect(html).toContain("tel:+447700900000");
  });

  test("address cell renders inline address", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.address!.cell(
        makeRow({ attendee: testAttendee({ address: "123 Main\nNew York" }) }),
        opts,
      ),
    ).toContain("123 Main");
  });

  test("special_instructions cell renders inline text", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.special_instructions!.cell(
        makeRow({
          attendee: testAttendee({ special_instructions: "VIP\nfront row" }),
        }),
        opts,
      ),
    ).toContain("VIP");
  });

  test("special_instructions cell renders empty when not provided", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.special_instructions!.cell(
        makeRow({ attendee: testAttendee({ special_instructions: "" }) }),
        opts,
      ),
    ).toBe("");
  });

  test("qty cell renders quantity", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.qty!.cell(
        makeRow({ attendee: testAttendee({ quantity: 3 }) }),
        opts,
      ),
    ).toBe("3");
  });

  test("ticket cell renders token link", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.ticket!.cell(
        makeRow({ attendee: testAttendee({ ticket_token: "abc123" }) }),
        opts,
      ),
    ).toContain("example.com/t/abc123");
  });

  test("registered cell renders formatted datetime", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.registered!.cell(
        makeRow({
          attendee: testAttendee({ created: "2026-01-01T12:00:00Z" }),
        }),
        opts,
      ),
    ).toContain("2026");
  });
});
