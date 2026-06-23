/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Progressive enhancement for the attendee form's shared date controls.
 *
 * The form works without JavaScript — the start date and day-count select are
 * plain fields. This script makes the date-first flow nicer:
 *   - the day-count (end date) select is hidden until a start date is chosen;
 *   - its option labels show the resulting end date, recomputed as the start
 *     date changes (matching the server's `formatDateLabel`);
 *   - the "availability is inaccurate until dates have been saved" notice is
 *     re-shown whenever the start date or length is changed, prompting a re-save.
 */

// Mirrors the server's `formatDateLabel` ("Sunday 15 March 2026") without
// duplicating its month/day name tables — the English parts come from Intl and
// are reassembled in the same order.
const PARTS_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  weekday: "long",
  year: "numeric",
});

/** End-date label for an `n`-day booking starting on `iso` (UTC), matching the
 * server's `formatDateLabel(addDays(start, n - 1))`. */
const endDateLabel = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (n - 1));
  const parts = new Map(
    PARTS_FORMAT.formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.get("weekday")} ${parts.get("day")} ${parts.get("month")} ${parts.get("year")}`;
};

export const initAttendeeDates = (): void => {
  const start = document.querySelector<HTMLInputElement>(
    'input[name="start_date"]',
  );
  if (!start) return;
  const dayCount = document.querySelector<HTMLSelectElement>(
    'select[name="day_count"]',
  );
  const dayCountLabel = document.querySelector<HTMLElement>(
    "[data-day-count-label]",
  );
  const notice = document.querySelector<HTMLElement>(
    "[data-availability-notice]",
  );

  const updateLabels = (): void => {
    if (!dayCount || !start.value) return;
    for (const opt of Array.from(dayCount.options)) {
      const n = Number(opt.value);
      opt.textContent = `${n} day${n === 1 ? "" : "s"}: ${endDateLabel(start.value, n)}`;
    }
  };

  // Reveal the end-date select only once a start date is present.
  const syncGate = (): void => {
    if (dayCountLabel) dayCountLabel.hidden = !start.value;
  };

  const reshowNotice = (): void => {
    if (notice) notice.hidden = false;
  };

  syncGate();
  updateLabels();
  start.addEventListener("input", () => {
    syncGate();
    updateLabels();
    reshowNotice();
  });
  dayCount?.addEventListener("change", reshowNotice);
};
