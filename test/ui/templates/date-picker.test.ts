import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  DatePicker,
  type DatePickerDate,
  type DatePickerProps,
} from "#templates/date-picker.tsx";
import { selectOptionLabels } from "#test-utils";

const baseProps: DatePickerProps = {
  ariaLabel: "Select a date",
  clearHref: "/clear",
  dates: [],
  dayHref: (v) => `/go/${v}`,
  monthHref: (m) => `/m/${m}`,
  selected: null,
  today: "2026-03-10",
  viewMonth: null,
};

const render = (overrides: Partial<DatePickerProps> = {}): string =>
  String(DatePicker({ ...baseProps, ...overrides }));

const date = (overrides: Partial<DatePickerDate>): DatePickerDate => ({
  label: "A date",
  selectable: true,
  value: "2026-03-12",
  ...overrides,
});

/** Option labels of the day dropdown only (excludes the month picker). */
const daySelectOptions = (html: string): (string | undefined)[] =>
  selectOptionLabels(html, baseProps.ariaLabel);

describe("DatePicker month resolution", () => {
  test("defaults the displayed month to today's month", () => {
    expect(render()).toMatch(/<option selected[^>]*>March 2026<\/option>/);
  });

  test("derives the displayed month from the selected date", () => {
    const html = render({ selected: "2026-07-15" });
    expect(html).toMatch(/<option selected[^>]*>July 2026<\/option>/);
  });

  test("an explicit view month overrides the selected date's month", () => {
    const html = render({ selected: "2026-07-15", viewMonth: "2026-09" });
    expect(html).toMatch(/<option selected[^>]*>September 2026<\/option>/);
  });
});

describe("DatePicker month select", () => {
  const monthSelect = (html: string): string =>
    html.match(
      /<select[^>]*calendar-month-select[^>]*>([\s\S]*?)<\/select>/,
    )![1]!;

  test("the month label is a nav-select that reads as plain text", () => {
    const html = render();
    expect(html).toContain('class="calendar-month-select"');
    expect(monthSelect(html)).toBeDefined();
    expect(html).toContain("data-nav-select");
  });

  test("lists every month from five years before to five years after", () => {
    const labels = [
      ...monthSelect(render()).matchAll(/>([^<]+)<\/option>/g),
    ].map((m) => m[1]);
    expect(labels[0]).toBe("January 2021");
    expect(labels[labels.length - 1]).toBe("December 2031");
    expect(labels).toHaveLength(11 * 12);
  });

  test("each month option navigates via monthHref", () => {
    // April 2026 option carries the monthHref value (the arrows use href=).
    expect(render()).toContain('value="/m/2026-04"');
  });
});

describe("DatePicker month navigation", () => {
  test("links to the previous and next months", () => {
    const html = render();
    expect(html).toContain('href="/m/2026-02"');
    expect(html).toContain('href="/m/2026-04"');
  });

  test("navigation arrows have accessible labels", () => {
    const html = render();
    expect(html).toContain('aria-label="Previous month"');
    expect(html).toContain('aria-label="Next month"');
  });

  test("crosses the year boundary when paging forward from December", () => {
    const html = render({ viewMonth: "2026-12" });
    expect(html).toContain('href="/m/2027-01"');
  });
});

describe("DatePicker grid", () => {
  test("renders Monday-first weekday initials", () => {
    const html = render();
    const initials = [...html.matchAll(/calendar-dow">([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(initials).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
  });

  test("renders selectable dates as links", () => {
    const html = render({ dates: [date({ value: "2026-03-12" })] });
    expect(html).toContain('href="/go/2026-03-12"');
  });

  test("renders non-selectable dates as plain text, not links", () => {
    const html = render({
      dates: [date({ selectable: false, value: "2026-03-12" })],
    });
    expect(html).toContain('<span class="cal-day">12</span>');
    expect(html).not.toContain("/go/2026-03-12");
  });

  test("dates absent from the list are plain text", () => {
    // 2026-03-12 is in the grid but not in `dates`, so it is not a link.
    expect(render()).toContain('<span class="cal-day">12</span>');
  });

  test("marks today within the grid", () => {
    expect(render()).toContain('class="cal-day cal-day-today">10</span>');
  });

  test("marks the selected date as a link with aria-current", () => {
    const html = render({
      dates: [date({ value: "2026-03-15" })],
      selected: "2026-03-15",
    });
    expect(html).toContain('aria-current="date"');
    expect(html).toContain("cal-day-selected");
  });

  test("selectable but unselected days omit aria-current", () => {
    const html = render({ dates: [date({ value: "2026-03-12" })] });
    expect(html).not.toContain("aria-current");
  });

  test("shows one extra week of adjacent-month context either side", () => {
    // March 2026: grid runs Mon 16 Feb → Sun 12 Apr (whole weeks + a week each side).
    const html = render();
    expect(html).toContain('class="cal-day cal-day-muted">16</span>'); // 16 Feb
    expect(html).toContain('class="cal-day cal-day-muted">12</span>'); // 12 Apr
  });
});

describe("DatePicker dropdown", () => {
  test("renders a navigable select with a clear option", () => {
    const html = render();
    expect(html).toContain("data-nav-select");
    expect(html).toContain("Select a date");
  });

  test("the clear option is selected when nothing is chosen", () => {
    const html = render();
    expect(html).toContain('<option selected value="/clear">Select a date');
  });

  test("the clear option is not selected when a date is chosen", () => {
    const html = render({
      dates: [date({ label: "Pick", value: "2026-03-15" })],
      selected: "2026-03-15",
    });
    expect(html).toContain('<option value="/clear">Select a date');
  });

  test("selectable dates are options linking to their day href", () => {
    const html = render({
      dates: [date({ label: "Pick me", value: "2026-03-15" })],
    });
    expect(html).toContain('<option value="/go/2026-03-15">Pick me</option>');
  });

  test("the chosen date's option is marked selected", () => {
    const html = render({
      dates: [date({ label: "Pick", value: "2026-03-15" })],
      selected: "2026-03-15",
    });
    expect(html).toContain('<option selected value="/go/2026-03-15">Pick');
  });

  test("non-selectable dates are disabled options", () => {
    const html = render({
      dates: [date({ label: "Closed", selectable: false })],
    });
    expect(html).toContain("<option disabled>Closed</option>");
  });

  test("inserts the clear option between past and future dates", () => {
    const html = render({
      dates: [
        date({ label: "Past", value: "2026-03-01" }),
        date({ label: "Future", value: "2026-03-20" }),
      ],
    });
    expect(daySelectOptions(html)).toEqual(["Past", "Select a date", "Future"]);
  });

  test("appends the clear option when every date is in the past", () => {
    const html = render({
      dates: [
        date({ label: "Past A", value: "2026-03-01" }),
        date({ label: "Past B", value: "2026-03-02" }),
      ],
    });
    expect(daySelectOptions(html)).toEqual([
      "Past A",
      "Past B",
      "Select a date",
    ]);
  });
});
