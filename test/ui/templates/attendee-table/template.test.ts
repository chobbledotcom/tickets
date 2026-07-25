import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type AttendeeColumnOpts,
  type AttendeeTableRow,
  attendeeTable,
} from "#templates/attendee-table.tsx";
import { testAttendee } from "#test-utils/factories.ts";
import { attendeeTableSuite, makeOpts, makeRow, render } from "./shared.ts";

const headersOf = (html: string): (string | undefined)[] =>
  [...html.matchAll(/<th(?:\s[^>]*)?>([^<]*)<\/th>/g)].map((match) => match[1]);

const rawValue = (key: string, row: AttendeeTableRow): unknown => {
  const read = attendeeTable.columnMap.get(key)?.rawValue;
  if (read === undefined) throw new Error(`Column ${key} has no raw value`);
  const opts: AttendeeColumnOpts = {
    allowedDomain: "example.com",
    answerQuestionMap: new Map(),
    answerTextMap: new Map(),
    phonePrefix: "44",
    renderStatus: () => "",
  };
  return read(row, opts);
};

attendeeTableSuite(() => {
  test("renders only specified columns in template order", () => {
    const html = render(
      makeOpts({
        columnLayout: attendeeTable.parse("{{name}}, {{qty}}, {{registered}}"),
        showCheckin: false,
      }),
    );
    expect(headersOf(html)).toEqual(["Name", "Qty", "Registered"]);
  });

  test("rejects an invalid template before rendering", () => {
    expect(() => attendeeTable.parse("{{invalid_column}}")).toThrow(
      'Unknown column "invalid_column"',
    );
  });

  test("hides a data-dependent template column with no data", () => {
    const attendee = testAttendee({ email: "" });
    const html = render(
      makeOpts({
        columnLayout: attendeeTable.parse("{{name}}, {{email}}, {{qty}}"),
        rows: [makeRow({ attendee })],
        showCheckin: false,
      }),
    );
    expect(html).not.toContain("<th>Email</th>");
  });

  test("reorders columns as specified", () => {
    const attendee = testAttendee({ email: "a@b.com" });
    const html = render(
      makeOpts({
        columnLayout: attendeeTable.parse("{{qty}}, {{name}}, {{email}}"),
        rows: [makeRow({ attendee })],
        showCheckin: false,
      }),
    );
    expect(headersOf(html)).toEqual(["Qty", "Name", "Email"]);
  });

  test("applies a date filter to Registered", () => {
    const attendee = testAttendee({ created: "2026-04-10T14:00:00Z" });
    const html = render(
      makeOpts({
        columnLayout: attendeeTable.parse(
          '{{name}}, {{registered | date: "%B %d, %Y"}}',
        ),
        rows: [makeRow({ attendee })],
        showCheckin: false,
      }),
    );
    expect(html).toContain("April 10, 2026");
  });

  test("renders the complete default Registered format", () => {
    const attendee = testAttendee({ created: "2026-04-10T14:00:00Z" });
    const html = render(
      makeOpts({
        columnLayout: attendeeTable.parse("{{name}}, {{registered}}"),
        rows: [makeRow({ attendee })],
        showCheckin: false,
      }),
    );
    expect(html).toContain("2026-04-10 15:00");
    expect(html).not.toContain("April 10, 2026");
  });

  test("returns raw attendee values for Liquid filters", () => {
    const row = makeRow({
      attendee: testAttendee({
        date: "2026-04-10",
        name: "Jane",
        quantity: 3,
      }),
    });

    expect(["name", "date", "qty"].map((key) => rawValue(key, row))).toEqual([
      "Jane",
      "2026-04-10",
      3,
    ]);
    expect(
      rawValue("date", makeRow({ attendee: testAttendee({ date: null }) })),
    ).toBe("");
  });
});
