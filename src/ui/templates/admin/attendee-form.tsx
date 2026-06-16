/**
 * Unified add/edit attendee page template.
 *
 * Renders the same form shape for both `/admin/attendees/new` (create) and
 * `/admin/attendees/:id` (edit). The line-item editor is a plain HTML
 * table — add/remove line controls are submit buttons that re-render the
 * form server-side, so the page works without JavaScript. A small inline
 * script progressively enhances date-field visibility (hide on non-daily
 * listings) but is not required for the form to function.
 */

import { compact } from "#fp";
import { t } from "#i18n";
import {
  ACTION_FIELD,
  ADD_LINE_ACTION,
  ATTENDEE_FORM_ID,
  type AttendeeFormLine,
  type BalanceNotice,
  type DailyDefaults,
  LINE_COUNT_FIELD,
  LINE_DATE_PREFIX,
  LINE_DAY_COUNT_PREFIX,
  LINE_EVENT_ID_PREFIX,
  LINE_KEY_PREFIX,
  LINE_QUANTITY_PREFIX,
  lineDayCount,
  type ParsedAttendeeForm,
  REMAINING_BALANCE_FIELD,
  REMOVE_LINE_ACTION_PREFIX,
  resolveStatusId,
  SAVE_ACTION,
  STATUS_FIELD,
} from "#routes/admin/attendee-form-model.ts";
import { targetQuery } from "#shared/bulk-email.ts";
import { toMajorUnits } from "#shared/currency.ts";
import { formatDateRangeLabel, formatDatetimeShort } from "#shared/dates.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { EmailStats } from "#shared/db/email-preferences.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  type AdminSession,
  type Attendee,
  availableDayCounts,
  type ListingWithCount,
} from "#shared/types.ts";
import {
  AttendeeAnswersTable,
  AttendeeDetail,
  AttendeeLogSection,
} from "#templates/admin/attendee-detail.tsx";
import { EditQuestions, PaymentDetails } from "#templates/admin/attendees.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  Icon,
  MaybeButtonLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Per-listing available dates (daily listings only) for client-side filtering. */
export type AttendeeFormTemplateData = {
  /** "create" or "edit". */
  mode: "create" | "edit";
  /** Parsed form values (lines + attendee fields). */
  parsed: ParsedAttendeeForm;
  /** Attendee being edited (edit mode only; create mode passes a shell). */
  attendee: Attendee | null;
  /** All selectable listings (active + any currently-selected inactive listings). */
  allListings: ListingWithCount[];
  /** All attendee statuses, for the status dropdown. */
  statuses: AttendeeStatus[];
  /** Status/balance mismatch notice, or null when they agree. */
  balanceNotice: BalanceNotice | null;
  /** Available dates per daily listing id (for the date picker). */
  availableDatesByListing: Record<number, string[]>;
  /** Offered day counts per customisable daily listing id (for the day-count
   * selector). */
  customisableByListing: Record<number, number[]>;
  /** Daily-line defaults computed from existing bookings. */
  dailyDefaults: DailyDefaults;
  /** Attendee-level error (e.g. "Name is required"). */
  attendeeError: string | null;
  /** Save outcome shown inside the form (success after a save, or a recoverable
   * failure like capacity lost to a race). */
  flashError?: string;
  flashSuccess?: string;
  /** Custom questions across the attendee's booked listings; empty in create
   * mode and when no listing has any. */
  questions: QuestionWithAnswers[];
  /** Currently-selected answer ids for the rendered questions. */
  selectedAnswerIds: number[];
  /** Today's ISO date — used for the new-daily-line default. */
  todayIso: string;
  /** Optional return URL the caller came from. */
  returnUrl?: string;
  /** Bulk-email contact history for the attendee's email (edit mode only;
   * null when there is no email on file or it has never been contacted). */
  emailStats?: EmailStats | null;
  /** Public site domain, for the read-only ticket link (edit mode). */
  allowedDomain: string;
  /** Country dialling code, for the read-only phone tel/WhatsApp links. */
  phonePrefix: string;
  /** This attendee's activity log entries, newest first (edit mode only). */
  activityLog: ActivityLogEntry[];
};

/** Status badges for an existing booking — "Checked in" and/or "Refunded",
 * space-separated. Renders nothing when the booking is absent or has neither
 * status, so a plain booking never leaves a stray node behind. */
const bookingStatusBadges = (
  booking: AttendeeFormLine["existingBooking"],
): JSX.Element | null => {
  const badges = compact([
    booking?.checked_in ? (
      <span class="badge">{t("attendee_form.checked_in")}</span>
    ) : null,
    booking?.refunded ? (
      <span class="badge danger">{t("attendee_form.refunded")}</span>
    ) : null,
  ]);
  return badges.length > 0 ? (
    <div class="muted small">
      <Raw html={badges.join(" ")} />
    </div>
  ) : null;
};

/** One row of the line-item editor — one listing registration. */
const LineRow = ({
  line,
  index,
  allListings,
}: {
  line: AttendeeFormLine;
  index: number;
  allListings: ListingWithCount[];
}): JSX.Element => {
  // The date field is hidden when a listing is picked and is non-daily; the
  // server validates it conditionally so it is never required at the HTML
  // level. Blank lines default to daily so a newly-added row shows the picker.
  const isDaily = !line.listing || line.listing.listing_type === "daily";
  const isCustomisable = Boolean(
    line.listing?.customisable_days && line.listing.listing_type === "daily",
  );
  const dayCounts = line.listing?.customisable_days
    ? availableDayCounts(line.listing)
    : [];
  const selectedDayCount = isCustomisable ? lineDayCount(line) : 0;
  const removeLabel = line.existingBooking
    ? t("attendee_form.remove")
    : t("attendee_form.drop");
  return (
    <tr data-line-row>
      <td>
        <select
          aria-label={`Listing for line ${index + 1}`}
          data-line-event
          name={`${LINE_EVENT_ID_PREFIX}${index}`}
        >
          <option selected={line.listingId === 0} value="">
            {t("attendee_form.select_listing")}
          </option>
          {allListings.map((listing) => (
            <option selected={listing.id === line.listingId} value={listing.id}>
              {listing.name}
              {listing.active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
        {bookingStatusBadges(line.existingBooking)}
      </td>
      <td>
        <input
          aria-label={`Date for line ${index + 1}`}
          data-line-date
          hidden={!isDaily}
          name={`${LINE_DATE_PREFIX}${index}`}
          type="date"
          value={line.date}
        />
        <select
          aria-label={`Number of days for line ${index + 1}`}
          data-line-day-count
          hidden={!isCustomisable}
          name={`${LINE_DAY_COUNT_PREFIX}${index}`}
        >
          {dayCounts.map((n) => (
            <option selected={n === selectedDayCount} value={n}>
              {t("attendee_form.day_count", { count: n })}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          aria-label={`Quantity for line ${index + 1}`}
          max={line.listing ? line.listing.max_quantity : undefined}
          min="1"
          name={`${LINE_QUANTITY_PREFIX}${index}`}
          style="width:5em"
          type="number"
          value={line.quantity === null ? "" : String(line.quantity)}
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
      </td>
      <td style="white-space:nowrap">
        <input
          name={`${LINE_KEY_PREFIX}${index}`}
          type="hidden"
          value={line.key}
        />
        <button
          class="link-button danger"
          formnovalidate
          name={ACTION_FIELD}
          type="submit"
          value={`${REMOVE_LINE_ACTION_PREFIX}${index}`}
        >
          {removeLabel}
        </button>
      </td>
    </tr>
  );
};

/** The repeatable line-item editor plus the hidden line-count field the parser
 * loops over. */
const LineEditor = ({
  data,
}: {
  data: AttendeeFormTemplateData;
}): JSX.Element => (
  <>
    <div class="table-scroll">
      <table class="line-editor">
        <thead>
          <tr>
            <th>{t("attendee_form.listing_header")}</th>
            <th>{t("attendee_form.date_header")}</th>
            <th>{t("attendee_form.qty_header")}</th>
            <th></th>
            <th style="width:1%"></th>
          </tr>
        </thead>
        <tbody>
          {data.parsed.lines.map((line, index) => (
            <LineRow allListings={data.allListings} index={index} line={line} />
          ))}
        </tbody>
      </table>
    </div>
    <input
      name={LINE_COUNT_FIELD}
      type="hidden"
      value={data.parsed.lines.length}
    />
  </>
);

/** Render the bulk-email contact history (edit mode only). Shows the contact
 * stats when the attendee has an email and has been contacted, otherwise a
 * placeholder. Owners also get a button to email just this attendee, prefilled
 * by token — disabled when there's no email address to send to. */
const EmailHistory = ({
  attendee,
  emailStats,
  isOwner,
}: {
  attendee: Attendee;
  emailStats: EmailStats | null;
  isOwner: boolean;
}): JSX.Element => {
  const hasEmail = Boolean(attendee.email);
  return (
    <article>
      <h3>{t("attendee_form.email_history")}</h3>
      {!hasEmail ? (
        <p>{t("attendee_form.no_email_on_file")}</p>
      ) : emailStats && emailStats.contactCount > 0 ? (
        <ul>
          <li>
            <strong>{t("attendee_form.total_messages")}:</strong>{" "}
            {emailStats.contactCount}
          </li>
          <li>
            <strong>{t("attendee_form.last_contacted")}:</strong>{" "}
            {formatDatetimeShort(emailStats.lastContact)}
          </li>
          <li>
            <strong>{t("attendee_form.last_subject")}:</strong>{" "}
            {emailStats.lastSubject}
          </li>
        </ul>
      ) : (
        <p>{t("attendee_form.never_contacted")}</p>
      )}
      {isOwner && (
        <p>
          <MaybeButtonLink
            class="btn"
            disabled={!hasEmail}
            href={`/admin/emails${targetQuery({
              kind: "attendee",
              token: attendee.ticket_token,
            })}`}
            title={
              hasEmail ? undefined : t("attendee_form.no_email_disabled_title")
            }
          >
            {t("attendee_form.send_email_to_attendee")}
          </MaybeButtonLink>
        </p>
      )}
    </article>
  );
};

/** Render the "Merge Attendee" section (edit mode only). */
const MergeSection = ({ attendee }: { attendee: Attendee }): JSX.Element => (
  <article>
    <div class="prose">
      <h3>{t("attendee_form.merge_attendee_title")}</h3>
      <p>{t("attendee_form.merge_attendee_description")}</p>
    </div>
    <form
      action={`/admin/attendees/${attendee.id}/merge`}
      class="inline-row"
      method="get"
    >
      <label for="merge_token">
        {t("attendee_form.ticket_token_label")}
        <input
          id="merge_token"
          name="token"
          placeholder={t("attendee_form.enter_ticket_token_placeholder")}
          required
          type="text"
        />
      </label>
      <SubmitButton icon="search">
        {t("attendee_form.search_button")}
      </SubmitButton>
    </form>
  </article>
);

/** Page title for the layout. */
const pageTitle = (data: AttendeeFormTemplateData): string =>
  data.mode === "create"
    ? t("attendee_form.add_attendee_title")
    : t("attendee_form.attendee_detail_title", { name: data.attendee!.name });

/**
 * The attendee's current status as an `<h2>`, shown only when the site has more
 * than one status configured (with a single status it carries no information).
 */
const StatusHeading = ({
  data,
}: {
  data: AttendeeFormTemplateData;
}): JSX.Element | null => {
  if (data.mode !== "edit" || !data.attendee || data.statuses.length <= 1) {
    return null;
  }
  const status = data.statuses.find((s) => s.id === data.attendee!.status_id);
  return (
    <h2>
      {t("attendee_form.status_heading", {
        status: status ? status.name : "None",
      })}
    </h2>
  );
};

/** Tiny progressive-enhancement script: hide the date field on non-daily
 * listings and populate defaults when a daily listing is first chosen. The
 * form is fully usable without it — the server validates conditionally. */
const renderEnhancementScript = (data: AttendeeFormTemplateData): string => {
  const availableDatesJson = JSON.stringify(data.availableDatesByListing);
  const listingsByType: Record<number, "daily" | "standard"> = {};
  for (const listing of data.allListings) {
    listingsByType[listing.id] = listing.listing_type;
  }
  const listingTypesJson = JSON.stringify(listingsByType);
  const customisableJson = JSON.stringify(data.customisableByListing);
  return `<script type="application/json" id="attendee-form-data" data-available-dates='${escapeHtml(availableDatesJson)}' data-listing-types='${escapeHtml(listingTypesJson)}' data-customisable='${escapeHtml(customisableJson)}'></script>
  <script>
    (function () {
      var dataEl = document.getElementById('attendee-form-data');
      if (!dataEl) return;
      var availableDates = JSON.parse(dataEl.getAttribute('data-available-dates') || '{}');
      var listingTypes = JSON.parse(dataEl.getAttribute('data-listing-types') || '{}');
      var customisable = JSON.parse(dataEl.getAttribute('data-customisable') || '{}');
      function updateRow(row) {
        var select = row.querySelector('[data-line-event]');
        var dateInput = row.querySelector('[data-line-date]');
        if (!select || !dateInput) return;
        var listingId = Number(select.value);
        var isDaily = listingTypes[listingId] === 'daily';
        dateInput.hidden = !isDaily;
        if (isDaily && !dateInput.value) {
          var dates = availableDates[listingId] || [];
          if (dates.length) dateInput.value = dates[0];
        }
        var daySelect = row.querySelector('[data-line-day-count]');
        if (daySelect) {
          var counts = customisable[listingId];
          var isCustomisable = isDaily && counts && counts.length;
          daySelect.hidden = !isCustomisable;
          if (isCustomisable) {
            var prev = daySelect.value;
            daySelect.innerHTML = counts.map(function (n) {
              return '<option value="' + n + '"' + (String(n) === prev ? ' selected' : '') + '>' + n + (n === 1 ? ' day' : ' days') + '</option>';
            }).join('');
          }
        }
      }
      document.querySelectorAll('[data-line-row]').forEach(function (row) {
        var select = row.querySelector('[data-line-event]');
        if (select) select.addEventListener('change', function () { updateRow(row); });
        updateRow(row);
      });
    })();
  </script>`;
};

/**
 * Status dropdown, outstanding-balance editor, and a status/balance mismatch
 * notice (precomputed by the route): a warning for a paid status that still
 * owes or a reservation that's lost its balance, and a softer info nudge for a
 * fully-paid reservation. A reservation that still owes is the normal state and
 * shows nothing.
 */
const StatusAndBalanceFields = ({
  data,
}: {
  data: AttendeeFormTemplateData;
}): JSX.Element => {
  const { statusId, remainingBalance } = data.parsed;
  // An attendee always resolves to a concrete status: their own when set,
  // otherwise the public default (the status new bookings start in). There is
  // no "no status" choice — with multiple statuses we fall back to the default,
  // and with a single status the field isn't shown at all. The save path uses
  // the same resolver so a blank submission can't clear the status either.
  const selectedId = resolveStatusId(statusId, data.statuses);
  return (
    <>
      <h3>{t("attendee_form.status_and_balance_heading")}</h3>
      {data.balanceNotice && (
        <output class={data.balanceNotice.tone}>
          {data.balanceNotice.message}
        </output>
      )}
      {data.statuses.length <= 1 ? (
        // A lone status carries no information (mirrors the status heading), so
        // keep it off the form but still submit it so a save never clears it.
        <input name={STATUS_FIELD} type="hidden" value={selectedId} />
      ) : (
        <label for={STATUS_FIELD}>
          {t("attendee_form.status_label")}
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
        {t("attendee_form.outstanding_balance_label")}
        <input
          id={REMAINING_BALANCE_FIELD}
          inputmode="decimal"
          min="0"
          name={REMAINING_BALANCE_FIELD}
          step="0.01"
          type="number"
          value={toMajorUnits(remainingBalance)}
        />
        <small>{t("attendee_form.outstanding_balance_help")}</small>
      </label>
    </>
  );
};

/**
 * The editable attendee form: contact details, optional custom questions, and
 * the listing-line editor, all inside one CsrfForm. Status & Balance sit right
 * after the name and before the contact fields, per the agreed field order.
 * The add-line / remove-line / save buttons are all submitters of this one
 * form; the server distinguishes them by the `action` value.
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
      <Flash error={data.flashError} success={data.flashSuccess} />
      {data.returnUrl && (
        <input name="return_url" type="hidden" value={data.returnUrl} />
      )}

      {!isEdit && <h3>{t("attendee_form.attendee_details_heading")}</h3>}

      <label for="name">
        {t("attendee_form.name_label")}
        <input
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
        {t("attendee_form.email_label")}
        <input
          id="email"
          name="email"
          type="email"
          value={data.parsed.email || ""}
        />
      </label>

      <label for="phone">
        {t("attendee_form.phone_label")}
        <input
          id="phone"
          name="phone"
          pattern="[+\d][\d\s\-()]{5,}"
          title={t("attendee_form.phone_pattern_title")}
          type="text"
          value={data.parsed.phone || ""}
        />
      </label>

      <label for="address">
        {t("attendee_form.address_label")}
        <textarea id="address" maxlength={250} name="address" rows={3}>
          {data.parsed.address || ""}
        </textarea>
      </label>

      <label for="special_instructions">
        {t("attendee_form.special_instructions_label")}
        <textarea
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
          <h3>{t("attendee_form.custom_questions_heading")}</h3>
          <EditQuestions
            questions={data.questions}
            selectedAnswerIds={data.selectedAnswerIds}
          />
        </>
      )}

      <h3>{t("attendee_form.listing_registrations_heading")}</h3>
      <LineEditor data={data} />
      <p>
        <button
          formnovalidate
          name={ACTION_FIELD}
          type="submit"
          value={ADD_LINE_ACTION}
        >
          <Icon name="plus" />
          <span>{t("attendee_form.add_listing_line_button")}</span>
        </button>
      </p>

      <hr />

      <p class="form-actions">
        <button
          class="primary"
          name={ACTION_FIELD}
          type="submit"
          value={SAVE_ACTION}
        >
          <Icon name="save" />
          <span>
            {isEdit
              ? t("attendee_form.save_attendee_button")
              : t("attendee_form.create_attendee_button")}
          </span>
        </button>
        {!isEdit && (
          <a class="button" href={data.returnUrl || "/admin/"}>
            {t("attendee_form.back_without_saving_link")}
          </a>
        )}
      </p>
    </CsrfForm>
  );
};

/**
 * Render the unified attendee form page (create or edit).
 *
 * The single CsrfForm wraps every input including the line editor, so the
 * add-line / remove-line / save buttons are all submitters of the same
 * form. The server distinguishes them by the `action` value.
 */
export const attendeeFormPage = (
  data: AttendeeFormTemplateData,
  session: AdminSession,
): string => {
  const isEdit = data.mode === "edit";
  const a = data.attendee;

  // In edit mode the read-only summary above is the primary view, so the form
  // is tucked into a collapsed disclosure (below); in create mode it is the page.
  const editForm = <AttendeeEditForm data={data} />;

  return String(
    <Layout title={pageTitle(data)}>
      <AdminNav active="/admin/" session={session} />

      <div class="prose">
        <h1>{pageTitle(data)}</h1>
        <StatusHeading data={data} />
      </div>

      {isEdit && a && (
        <AttendeeDetail
          allowedDomain={data.allowedDomain}
          attendee={a}
          phonePrefix={data.phonePrefix}
        />
      )}

      {isEdit && (
        <AttendeeAnswersTable
          questions={data.questions}
          selectedAnswerIds={data.selectedAnswerIds}
        />
      )}

      {isEdit && a && <Raw html={PaymentDetails({ attendee: a })} />}

      {isEdit && <AttendeeLogSection entries={data.activityLog} />}

      {data.attendeeError && (
        <div class="error" role="alert">
          {data.attendeeError}
        </div>
      )}

      {data.dailyDefaults.hasMixedTimings && (
        <output class="warning">
          {t("attendee_form.mixed_timings_warning")}
        </output>
      )}

      {isEdit ? (
        <details>
          <summary>{t("attendee_form.edit_attendee_details_summary")}</summary>
          {editForm}
        </details>
      ) : (
        editForm
      )}

      {isEdit && a && (
        <EmailHistory
          attendee={a}
          emailStats={data.emailStats ?? null}
          isOwner={session.adminLevel === "owner"}
        />
      )}

      {isEdit && a && <MergeSection attendee={a} />}

      <Raw html={renderEnhancementScript(data)} />
    </Layout>,
  );
};
