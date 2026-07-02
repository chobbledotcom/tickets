/**
 * The editable attendee form (create + edit).
 *
 * An attendee has ONE shared date range — a start date plus a length —
 * applied to every daily listing they book. The listing editor is a fixed
 * table with one quantity box per bookable listing (plus any inactive
 * listing the attendee already booked); quantity ≥ 1 books it, 0 leaves it
 * out, so there are no add/remove-line buttons. When something is already
 * booked (an edit, or a create pre-filled from the calendar) the not-booked
 * rows hide behind a "Show all listings" toggle (pure CSS); a bare create
 * form has nothing booked, so it drops the toggle and shows every listing.
 * The form works without JavaScript.
 *
 * `attendeeFormPage` is the standalone /admin/attendees/new page;
 * {@link AttendeeFormPanel} is the same warnings + errors + form block the
 * attendee entity page's Edit tab embeds (edit-pages.md).
 */

import { t } from "#i18n";
import {
  ATTENDEE_FORM_ID,
  type AttendeeFormLine,
  DAY_COUNT_FIELD,
  isPaymentLockedLine,
  isRetainedLine,
  LINE_KEY_PREFIX,
  NO_QUANTITY_PREFIX,
  type ParsedAttendeeForm,
  QTY_PREFIX,
  REMAINING_BALANCE_FIELD,
  resolveStatusId,
  SHOW_ALL_FIELD,
  STATUS_FIELD,
} from "#routes/admin/attendee-form-model.ts";
import {
  type AttendeeLogisticsData,
  endAgentField,
  endTimeField,
  SPLIT_AGENTS_FIELD,
  startAgentField,
  startTimeField,
} from "#routes/admin/attendee-logistics.ts";
import { toMajorUnits } from "#shared/currency.ts";
import { addDays, formatDateLabel, formatDateRangeLabel } from "#shared/dates.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { START_DATE_FIELD } from "#shared/order-select.ts";
import {
  type AdminSession,
  type Attendee,
  MAX_DURATION_DAYS,
} from "#shared/types.ts";
import type { BalanceNotice } from "#routes/admin/attendee-form-model.ts";
import { BookingStatusBadges } from "#templates/admin/attendee-detail.tsx";
import { EditQuestions } from "#templates/admin/attendees.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Icon } from "#templates/components/actions.tsx";
import { PHONE_INPUT_PATTERN } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** Template data for the attendee form: everything the editable form itself
 * renders. The other tabs' data (log, ledger, notes, contact history) lives
 * with those tabs, not here. */
export type AttendeeFormTemplateData = {
  /** "create" or "edit". */
  mode: "create" | "edit";
  /** Parsed form values (shared range + one line per rendered listing). */
  parsed: ParsedAttendeeForm;
  /** Attendee being edited (edit mode only; create mode passes null). */
  attendee: Attendee | null;
  /** All attendee statuses, for the status dropdown. */
  statuses: AttendeeStatus[];
  /** Status/balance mismatch notice, or null when they agree. */
  balanceNotice: BalanceNotice | null;
  /** True when the attendee's existing daily bookings disagree on date/length —
   * saving normalises them onto the one shared range. */
  hasMixedTimings: boolean;
  /** True when at least one daily listing is in play (active, or already booked
   * by this attendee). The shared date range only affects daily listings, so the
   * whole Dates section is hidden when this is false. */
  hasDailyListings: boolean;
  /** Attendee-level error (e.g. "Name is required"). */
  attendeeError: string | null;
  /** Shared-date error (e.g. missing start date for a booked daily listing). */
  dateError: string | null;
  /** Form-wide error shown above the form (e.g. a paid line was marked
   * no-quantity), kept out of the per-line quantity table. */
  formError: string | null;
  /** A recoverable save failure (capacity, no lines) shown above the form on
   * the in-place 400 re-render. */
  saveError?: string | undefined;
  /** Custom questions across the attendee's booked listings. */
  questions: QuestionWithAnswers[];
  /** Currently-selected answer ids for the rendered questions. */
  selectedAnswerIds: number[];
  /** Currently-entered free-text answers, keyed by question id. */
  selectedTextAnswers: Map<number, string>;
  /** Optional return URL the caller came from. */
  returnUrl?: string | undefined;
  /** Overbooking / over-duration warnings per listing id (booked lines only). */
  lineWarnings: Map<number, string[]>;
  /** All warnings flattened, for the top-of-form summary. */
  topWarnings: string[];
  /** Logistics selectors data, or undefined when logistics doesn't apply. */
  logistics?: AttendeeLogisticsData | undefined;
};

/** One row of the listing editor — a listing and its quantity box. */
const ListingRow = ({
  line,
  warnings,
}: {
  line: AttendeeFormLine;
  warnings: string[];
}): JSX.Element => {
  const listing = line.listing!;
  const booked = isRetainedLine(line) || Boolean(line.existingBooking);
  const isDaily = listing.listing_type === "daily";
  // A paid line can't be marked no-quantity until its charge is refunded, so the
  // box is disabled with an explaining tooltip rather than left to fail on save.
  const paymentLocked = isPaymentLockedLine(line);
  return (
    <tr class={booked ? "attendee-line" : "attendee-line attendee-line-empty"}>
      <td>
        <a href={`/admin/listing/${listing.id}`}>{listing.name}</a>
        {listing.active ? (
          ""
        ) : (
          <span class="muted small">({t("common.inactive")})</span>
        )}
        {BookingStatusBadges({
          checkedIn: Boolean(line.existingBooking?.checked_in),
          refunded: Boolean(line.existingBooking?.refunded),
        })}
      </td>
      <td>
        <span class="muted small">
          {isDaily
            ? t("attendee_form.shared_dates")
            : t("attendee_form.fixed_date")}
        </span>
      </td>
      <td class="attendee-line-qty">
        <input
          aria-label={t("attendee_form.qty_aria", { title: listing.name })}
          class="line-qty"
          max={listing.max_quantity}
          min="0"
          name={`${QTY_PREFIX}${listing.id}`}
          style="width:5em"
          type="number"
          value={line.quantity === null ? "0" : String(line.quantity)}
        />
        <label class="small">
          <input
            checked={line.noQuantity}
            class="no-quantity-toggle"
            disabled={paymentLocked}
            name={`${NO_QUANTITY_PREFIX}${listing.id}`}
            title={
              paymentLocked
                ? t("attendee_form.paid_no_quantity_line")
                : undefined
            }
            type="checkbox"
            value="1"
          />
          {t("attendee_form.no_quantity")}
        </label>
        <input
          name={`${LINE_KEY_PREFIX}${listing.id}`}
          type="hidden"
          value={line.key}
        />
      </td>
      <td>
        {line.existingBooking?.start_at ? (
          <div class="muted small">
            {formatDateRangeLabel(
              line.existingBooking.start_at,
              line.existingBooking.end_at,
            )}
          </div>
        ) : null}
        {line.error ? (
          <div class="error" role="alert">
            {line.error}
          </div>
        ) : null}
        {warnings.map((w) => (
          <div class="warning small" role="alert">
            {w}
          </div>
        ))}
      </td>
    </tr>
  );
};

/** The fixed listing editor: one quantity box per listing. When at least one
 * line is already booked — an edit, or a create deep-linked from the calendar
 * with pre-selected listings — the not-booked rows tuck behind an un-ticked
 * "Show all listings" toggle (pure CSS). A bare create form has nothing booked,
 * so every row would hide behind that toggle; there we drop it and show every
 * listing instead. */
const ListingEditor = ({
  data,
}: {
  data: AttendeeFormTemplateData;
}): JSX.Element => {
  const hasBookedLines = data.parsed.lines.some(
    (line) => isRetainedLine(line) || Boolean(line.existingBooking),
  );
  return (
    <div
      class={
        hasBookedLines ? "listing-editor" : "listing-editor show-all-listings"
      }
    >
      {hasBookedLines && (
        <label class="show-all">
          <input
            class="show-all-toggle"
            name={SHOW_ALL_FIELD}
            type="checkbox"
          />
          {t("attendee_form.show_all_listings")}
        </label>
      )}
      <div class="table-scroll">
        <table class="line-editor">
          <thead>
            <tr>
              <th>{t("terms.listing")}</th>
              <th>{t("attendee_form.col_dates")}</th>
              <th>{t("attendee_form.col_qty")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.parsed.lines.map((line) => (
              <ListingRow
                line={line}
                warnings={data.lineWarnings.get(line.listingId) ?? []}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/** One leg (start or end) as a single tidy row: a label, the time-of-day input
 * (logistics metadata only; never availability) and the agent select. Used for
 * the shared single pair (listingId omitted) or a specific listing (split). */
const LogisticsLeg = ({
  agents,
  leg,
  assignment,
  listingId,
}: {
  agents: AttendeeLogisticsData["agents"];
  leg: "start" | "end";
  assignment: AttendeeLogisticsData["single"];
  listingId?: number;
}): JSX.Element => {
  const isStart = leg === "start";
  const label = isStart
    ? t("attendee_form.start_leg")
    : t("attendee_form.end_leg");
  const time = isStart ? assignment.startTime : assignment.endTime;
  const agentId = isStart ? assignment.startAgentId : assignment.endAgentId;
  return (
    <div class="logistics-leg">
      <span class="logistics-leg-label">{label}</span>
      <input
        aria-label={
          isStart
            ? t("attendee_form.leg_time_start")
            : t("attendee_form.leg_time_end")
        }
        name={(isStart ? startTimeField : endTimeField)(listingId)}
        type="time"
        value={time}
      />
      <select
        aria-label={
          isStart
            ? t("attendee_form.leg_agent_start")
            : t("attendee_form.leg_agent_end")
        }
        class="logistics-leg-agent"
        name={(isStart ? startAgentField : endAgentField)(listingId)}
      >
        <option selected={agentId === null} value="">
          {t("attendee_form.agent_none")}
        </option>
        {agents.map((agent) => (
          <option selected={agent.id === agentId} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
    </div>
  );
};

/**
 * Logistics agent + time selectors for logistics listings. A "different agents
 * per item" checkbox switches (pure CSS) between one shared start/end pair and
 * a pair per logistics listing. Grouped in a fieldset/legend like the listing
 * editor. Only rendered when logistics applies.
 */
const LogisticsSection = ({
  data,
}: {
  data: AttendeeFormTemplateData;
}): JSX.Element | null => {
  const logistics = data.logistics;
  if (!logistics) return null;
  return (
    <fieldset class="logistics-agents listing-section">
      <legend>{t("attendee_form.logistics_heading")}</legend>
      <label class="split-agents">
        <input
          checked={logistics.split}
          class="split-agents-toggle"
          name={SPLIT_AGENTS_FIELD}
          type="checkbox"
          value="1"
        />
        {t("attendee_form.split_agents")}
      </label>
      <div class="logistics-single">
        <LogisticsLeg
          agents={logistics.agents}
          assignment={logistics.single}
          leg="start"
        />
        <LogisticsLeg
          agents={logistics.agents}
          assignment={logistics.single}
          leg="end"
        />
      </div>
      <div class="logistics-split">
        {logistics.lines.map((line) => (
          <fieldset class="logistics-line">
            <legend>{line.name}</legend>
            <LogisticsLeg
              agents={logistics.agents}
              assignment={line.assignment}
              leg="start"
              listingId={line.listingId}
            />
            <LogisticsLeg
              agents={logistics.agents}
              assignment={line.assignment}
              leg="end"
              listingId={line.listingId}
            />
          </fieldset>
        ))}
      </div>
    </fieldset>
  );
};

/** Option list for the day-count select: 1…horizon, each labelled with the
 * resulting end date when a start date is known. */
const dayCountOptions = (
  startDate: string,
  selected: number,
): JSX.Element[] => {
  const options: JSX.Element[] = [];
  for (let n = 1; n <= MAX_DURATION_DAYS; n++) {
    const label = startDate
      ? t("attendee_form.day_count_option_with_end", {
          count: n,
          end: formatDateLabel(addDays(startDate, n - 1)),
        })
      : t("attendee_form.day_count_option", { count: n });
    options.push(
      <option selected={n === selected} value={n}>
        {label}
      </option>,
    );
  }
  return options;
};

/** Shared start date + length for every daily listing. The length is a select
 * of day counts (the end date is derived, never edited directly). The
 * "availability inaccurate" notice shows until a date is saved, and a small
 * progressive-enhancement script (client/admin/attendee-dates.ts) re-shows it
 * when the dates are changed and reveals the length select once a start date is
 * set.
 *
 * The dates only apply to daily listings, so the whole section is hidden when
 * there are none in play, and the start date is never HTML-`required` — it's
 * optional unless a daily listing is actually booked, which the server enforces. */
const SharedDateFields = ({
  data,
}: {
  data: AttendeeFormTemplateData;
}): JSX.Element | null => {
  if (!data.hasDailyListings) return null;
  // Shown when there's no saved/known date yet (a bare create form); the PE
  // re-shows it whenever the dates are dirtied so the operator re-saves.
  const noticeHidden = !(data.mode === "create" && !data.parsed.startDate);
  return (
    <>
      <h3>{t("attendee_form.dates_heading")}</h3>
      <p class="small">{t("attendee_form.dates_hint")}</p>
      {data.dateError && (
        <output class="error" role="alert">
          {data.dateError}
        </output>
      )}
      <label for={START_DATE_FIELD}>
        {t("attendee_form.start_date")}
        <input
          id={START_DATE_FIELD}
          name={START_DATE_FIELD}
          type="date"
          value={data.parsed.startDate}
        />
      </label>
      <output class="warning" data-availability-notice hidden={noticeHidden}>
        {t("attendee_form.availability_notice")}
      </output>
      <label data-day-count-label for={DAY_COUNT_FIELD}>
        {t("attendee_form.length")}
        <select id={DAY_COUNT_FIELD} name={DAY_COUNT_FIELD}>
          {dayCountOptions(data.parsed.startDate, data.parsed.dayCount)}
        </select>
      </label>
    </>
  );
};

/**
 * Status dropdown, outstanding-balance editor, and a status/balance mismatch
 * notice (precomputed by the route).
 */
const StatusAndBalanceFields = ({
  data,
}: {
  data: AttendeeFormTemplateData;
}): JSX.Element => {
  const { statusId, remainingBalance } = data.parsed;
  const selectedId = resolveStatusId(statusId, data.statuses);
  return (
    <>
      <h3>{t("attendee_form.status_balance_heading")}</h3>
      {data.balanceNotice && (
        <output class={data.balanceNotice.tone}>
          {data.balanceNotice.message}
        </output>
      )}
      {data.statuses.length <= 1 ? (
        <input name={STATUS_FIELD} type="hidden" value={selectedId} />
      ) : (
        <label for={STATUS_FIELD}>
          {t("common.status")}
          <select id={STATUS_FIELD} name={STATUS_FIELD}>
            {data.statuses.map((s) => (
              <option selected={s.id === selectedId} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label for={REMAINING_BALANCE_FIELD}>
        {t("attendee_form.outstanding_balance")}
        <input
          id={REMAINING_BALANCE_FIELD}
          inputmode="decimal"
          min="0"
          name={REMAINING_BALANCE_FIELD}
          step="0.01"
          type="number"
          value={toMajorUnits(remainingBalance)}
        />
        <small>{t("attendee_form.outstanding_balance_hint")}</small>
      </label>
      <div class="error" role="alert">
        {t("attendee_form.balance_ledger_note")}
      </div>
    </>
  );
};

/**
 * The editable attendee form: contact details, the shared date range, optional
 * custom questions, and the listing editor — all inside one CsrfForm. The
 * CsrfForm renders the flash inline when a redirect targeted this form's id.
 */
const AttendeeEditForm = ({
  data,
}: {
  data: AttendeeFormTemplateData;
}): JSX.Element => {
  const isEdit = data.mode === "edit";
  const formAction =
    data.mode === "create"
      ? "/admin/attendees/new"
      : `/admin/attendees/${data.attendee!.id}`;
  return (
    <CsrfForm action={formAction} id={ATTENDEE_FORM_ID}>
      {data.returnUrl && (
        <input name="return_url" type="hidden" value={data.returnUrl} />
      )}

      {!isEdit && <h3>{t("attendee_form.details_heading")}</h3>}

      <label for="name">
        {t("common.name")}
        <input
          autocomplete="off"
          autofocus
          id="name"
          name="name"
          required
          type="text"
          value={data.parsed.name}
        />
      </label>

      <StatusAndBalanceFields data={data} />

      <label for="email">
        {t("common.email")}
        <input
          autocomplete="off"
          id="email"
          name="email"
          type="email"
          value={data.parsed.email || ""}
        />
      </label>

      <label for="phone">
        {t("common.phone")}
        <input
          autocomplete="off"
          id="phone"
          name="phone"
          pattern={PHONE_INPUT_PATTERN}
          title={t("attendee_form.phone_title")}
          type="text"
          value={data.parsed.phone || ""}
        />
      </label>

      <label for="address">
        {t("common.address")}
        <textarea
          autocomplete="off"
          id="address"
          maxlength={250}
          name="address"
          rows={3}
        >
          {data.parsed.address || ""}
        </textarea>
      </label>

      <label for="special_instructions">
        {t("common.special_instructions")}
        <textarea
          autocomplete="off"
          id="special_instructions"
          maxlength={250}
          name="special_instructions"
          rows={3}
        >
          {data.parsed.special_instructions || ""}
        </textarea>
      </label>

      {data.questions.length > 0 && (
        <>
          <h3>{t("attendee_form.custom_questions")}</h3>
          <EditQuestions
            questions={data.questions}
            selectedAnswerIds={data.selectedAnswerIds}
            selectedTextAnswers={data.selectedTextAnswers}
          />
        </>
      )}

      <SharedDateFields data={data} />

      <h3>{t("attendee_form.registrations_heading")}</h3>
      {data.hasMixedTimings && (
        <output class="warning">
          {t("attendee_form.mixed_timings_warning")}
        </output>
      )}
      <ListingEditor data={data} />

      <LogisticsSection data={data} />

      <hr />

      <p class="form-actions">
        <button class="primary" type="submit">
          <Icon name="save" />
          <span>
            {isEdit ? t("attendee_form.save") : t("attendee_form.create")}
          </span>
        </button>
      </p>
    </CsrfForm>
  );
};

/**
 * The full form block: save/form errors, the warnings summary, the
 * attendee-level error, then the form itself. Rendered as the whole create
 * page and as the entity page's Edit tab.
 */
export const AttendeeFormPanel = ({
  data,
}: {
  data: AttendeeFormTemplateData;
}): JSX.Element => (
  <>
    {data.saveError && (
      <output class="error" role="alert">
        {data.saveError}
      </output>
    )}
    {data.formError && (
      <output class="error" role="alert">
        {data.formError}
      </output>
    )}
    {data.topWarnings.length > 0 && (
      <output class="warning" role="alert">
        <strong>{t("attendee_form.double_check")}</strong>
        <ul>
          {data.topWarnings.map((w) => (
            <li>{w}</li>
          ))}
        </ul>
      </output>
    )}
    {data.attendeeError && (
      <div class="error" role="alert">
        {data.attendeeError}
      </div>
    )}
    <AttendeeEditForm data={data} />
  </>
);

/** Render the standalone create page (/admin/attendees/new). Edit renders
 * through the attendee entity page instead. */
export const attendeeFormPage = (
  data: AttendeeFormTemplateData,
  session: AdminSession,
): string =>
  String(
    <Layout title={t("attendee_form.title_create")}>
      <AdminNav active="/admin/attendees" session={session} />
      <div class="prose">
        <h1>{t("attendee_form.title_create")}</h1>
      </div>
      <AttendeeFormPanel data={data} />
    </Layout>,
  );
