/**
 * Reusable, link-based date picker: a small month calendar above a navigable
 * dropdown of the same dates. Selectable dates render as links; non-selectable
 * dates render as plain greyed text. Paging months only changes which month the
 * grid displays — it never changes the current selection — so stepping through
 * months never lands the viewer on an empty date.
 *
 * The component is metric-agnostic: callers decide which dates are selectable,
 * so it works equally for bookings, availability, or any other rule.
 */

import { compact, map } from "#fp";
import { t } from "#i18n";
import type { SafeHtml } from "#jsx/jsx-runtime.ts";
import {
  calendarGridDates,
  formatMonthLabel,
  monthsAround,
  shiftMonth,
} from "#shared/dates.ts";

/** A single date offered by the picker. */
export type DatePickerDate = {
  /** ISO YYYY-MM-DD date. */
  value: string;
  /** Human-readable label for the dropdown, e.g. "Monday 15 March 2026". */
  label: string;
  /** Whether this date is a clickable link (vs. plain greyed text). */
  selectable: boolean;
};

export type DatePickerProps = {
  /** All known dates, sorted ascending by ISO `value`. */
  dates: DatePickerDate[];
  /** Currently selected date (drives highlight + dropdown), or null. */
  selected: string | null;
  /** Today as YYYY-MM-DD: default month, today marker, dropdown past/future split. */
  today: string;
  /** Month to display as YYYY-MM, or null to derive from `selected`/`today`. */
  viewMonth: string | null;
  /** Build the href for a selectable day. */
  dayHref: (value: string) => string;
  /** Href for the "clear selection" dropdown option. */
  clearHref: string;
  /** Build the href for paging to a different month (YYYY-MM). */
  monthHref: (month: string) => string;
  /** Accessible label for the dropdown. */
  ariaLabel: string;
  /** Id for the calendar `<div>` (and the fragment month links target). Defaults
   *  to `"calendar"`; override it so two pickers on one page stay unique. */
  anchorId?: string;
};

/** Monday-first weekday initials for the grid header. */
const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

/** Build the space-separated class list for a single day cell. */
const dayClasses = (
  value: string,
  viewMonth: string,
  selected: string | null,
  today: string,
): string =>
  compact([
    "cal-day",
    value.slice(0, 7) === viewMonth ? null : "cal-day-muted",
    value === today ? "cal-day-today" : null,
    value === selected ? "cal-day-selected" : null,
  ]).join(" ");

/** The current selection context shared by the month grid and the dropdown:
 * which date is chosen, what counts as today, and how to link a day. */
type DaySelection = {
  selected: string | null;
  today: string;
  dayHref: (value: string) => string;
};

/** Render one day: a link when selectable, plain text otherwise. */
const renderDay =
  (
    byValue: Map<string, DatePickerDate>,
    viewMonth: string,
    sel: DaySelection,
  ) =>
  (value: string): SafeHtml => {
    const dayNum = new Date(`${value}T00:00:00Z`).getUTCDate();
    const cls = dayClasses(value, viewMonth, sel.selected, sel.today);
    return byValue.get(value)?.selectable ? (
      <a
        aria-current={value === sel.selected ? "date" : undefined}
        class={cls}
        href={sel.dayHref(value)}
      >
        {dayNum}
      </a>
    ) : (
      <span class={cls}>{dayNum}</span>
    );
  };

/** Render the dropdown, splitting past from future with a "Select a date" entry. */
const renderSelect = (
  dates: DatePickerDate[],
  sel: DaySelection,
  clearHref: string,
  ariaLabel: string,
): SafeHtml => {
  const options: SafeHtml[] = map(
    (d: DatePickerDate): SafeHtml =>
      d.selectable ? (
        <option
          selected={sel.selected === d.value}
          value={sel.dayHref(d.value)}
        >
          {d.label}
        </option>
      ) : (
        <option disabled>{d.label}</option>
      ),
  )(dates);
  const splitIndex = dates.findIndex((d) => d.value >= sel.today);
  const insertAt = splitIndex === -1 ? options.length : splitIndex;
  options.splice(
    insertAt,
    0,
    <option selected={!sel.selected} value={clearHref}>
      {t("datepicker.select_date")}
    </option>,
  );
  return (
    <select aria-label={ariaLabel} data-nav-select>
      {options}
    </select>
  );
};

/** A small month calendar plus an equivalent navigable dropdown. */
export const DatePicker = ({
  dates,
  selected,
  today,
  viewMonth,
  dayHref,
  clearHref,
  monthHref,
  ariaLabel,
  anchorId = "calendar",
}: DatePickerProps): SafeHtml => {
  const byValue = new Map(
    map((d: DatePickerDate) => [d.value, d] as const)(dates),
  );
  const month = viewMonth ?? (selected ?? today).slice(0, 7);
  const sel: DaySelection = { dayHref, selected, today };
  const day = renderDay(byValue, month, sel);
  return (
    <div class="date-picker">
      <div class="calendar" id={anchorId}>
        <div class="calendar-nav">
          <a
            aria-label={t("datepicker.previous_month")}
            href={monthHref(shiftMonth(month, -1))}
          >
            ←
          </a>
          <select
            aria-label={t("datepicker.jump_to_month")}
            class="calendar-month-select"
            data-nav-select
          >
            {map(
              (ym: string): SafeHtml => (
                <option selected={ym === month} value={monthHref(ym)}>
                  {formatMonthLabel(ym)}
                </option>
              ),
            )(monthsAround(month, 5))}
          </select>
          <a
            aria-label={t("datepicker.next_month")}
            href={monthHref(shiftMonth(month, 1))}
          >
            →
          </a>
        </div>
        <div class="calendar-grid">
          {map((d: string): SafeHtml => <span class="calendar-dow">{d}</span>)(
            WEEKDAY_INITIALS,
          )}
          {map(day)(calendarGridDates(month))}
        </div>
      </div>
      {renderSelect(dates, sel, clearHref, ariaLabel)}
    </div>
  );
};
