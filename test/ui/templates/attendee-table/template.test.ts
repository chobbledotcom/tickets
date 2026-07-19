import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { COLUMN_LAYOUTS } from "#shared/column-order.ts";
import { AttendeeTable } from "#templates/attendee-table.tsx";
import { testAttendee } from "#test-utils/factories.ts";
import { attendeeTableSuite, makeOpts, makeRow } from "./shared.ts";

const headersOf = (html: string): (string | undefined)[] =>
  [...html.matchAll(/<th(?:\s[^>]*)?>([^<]*)<\/th>/g)].map((match) => match[1]);

attendeeTableSuite(() => {
  test("renders only specified columns in template order", () => {
    const html = AttendeeTable(
      makeOpts({
        columnLayout: COLUMN_LAYOUTS.attendee.parse(
          "{{name}}, {{qty}}, {{registered}}",
        ),
        showCheckin: false,
      }),
    );
    expect(headersOf(html)).toEqual(["Name", "Qty", "Registered"]);
  });

  test("rejects an invalid template before rendering", () => {
    expect(() => COLUMN_LAYOUTS.attendee.parse("{{invalid_column}}")).toThrow(
      'Unknown column "invalid_column"',
    );
  });

  test("hides a data-dependent template column with no data", () => {
    const attendee = testAttendee({ email: "" });
    const html = AttendeeTable(
      makeOpts({
        columnLayout: COLUMN_LAYOUTS.attendee.parse(
          "{{name}}, {{email}}, {{qty}}",
        ),
        rows: [makeRow({ attendee })],
        showCheckin: false,
      }),
    );
    expect(html).not.toContain("<th>Email</th>");
  });

  test("reorders columns as specified", () => {
    const attendee = testAttendee({ email: "a@b.com" });
    const html = AttendeeTable(
      makeOpts({
        columnLayout: COLUMN_LAYOUTS.attendee.parse(
          "{{qty}}, {{name}}, {{email}}",
        ),
        rows: [makeRow({ attendee })],
        showCheckin: false,
      }),
    );
    expect(headersOf(html)).toEqual(["Qty", "Name", "Email"]);
  });

  test("applies a date filter to Registered", () => {
    const attendee = testAttendee({ created: "2026-04-10T14:00:00Z" });
    const html = AttendeeTable(
      makeOpts({
        columnLayout: COLUMN_LAYOUTS.attendee.parse(
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
    const html = AttendeeTable(
      makeOpts({
        columnLayout: COLUMN_LAYOUTS.attendee.parse("{{name}}, {{registered}}"),
        rows: [makeRow({ attendee })],
        showCheckin: false,
      }),
    );
    expect(html).toContain("2026-04-10 15:00");
    expect(html).not.toContain("April 10, 2026");
  });
});
