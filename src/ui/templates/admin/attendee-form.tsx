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

import {
  ACTION_FIELD,
  ADD_LINE_ACTION,
  ATTENDEE_FORM_ID,
  type AttendeeFormLine,
  type DailyDefaults,
  LINE_COUNT_FIELD,
  LINE_DATE_PREFIX,
  LINE_EVENT_ID_PREFIX,
  LINE_KEY_PREFIX,
  LINE_QUANTITY_PREFIX,
  type ParsedAttendeeForm,
  REMOVE_LINE_ACTION_PREFIX,
  SAVE_ACTION,
} from "#routes/admin/attendee-form-model.ts";
import { formatDateRangeLabel, formatDatetimeShort } from "#shared/dates.ts";
import type { EmailStats } from "#shared/db/email-preferences.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminSession,
  Attendee,
  ListingWithCount,
} from "#shared/types.ts";
import { EditQuestions, PaymentDetails } from "#templates/admin/attendees.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Icon, SubmitButton } from "#templates/components/actions.tsx";
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
  /** Available dates per daily listing id (for the date picker). */
  availableDatesByListing: Record<number, string[]>;
  /** Daily-line defaults computed from existing bookings. */
  dailyDefaults: DailyDefaults;
  /** Attendee-level error (e.g. "Name is required"). */
  attendeeError: string | null;
  /** Save outcome shown inside the form (success after a save, or a recoverable
   * failure like capacity lost to a race). */
  flashError?: string;
  flashSuccess?: string;
  /** Custom questions for the first existing listing (edit mode only). */
  questions?: QuestionWithAnswers[];
  /** Currently-selected answer ids for the rendered questions. */
  selectedAnswerIds: number[];
  /** Today's ISO date — used for the new-daily-line default. */
  todayIso: string;
  /** Optional return URL the caller came from. */
  returnUrl?: string;
  /** Bulk-email contact history for the attendee's email (edit mode only;
   * null when there is no email on file or it has never been contacted). */
  emailStats?: EmailStats | null;
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
  const removeLabel = line.existingBooking ? "Remove" : "Drop";
  return (
    <tr data-line-row>
      <td>
        <select
          aria-label={`Listing for line ${index + 1}`}
          data-line-event
          name={`${LINE_EVENT_ID_PREFIX}${index}`}
        >
          <option selected={line.listingId === 0} value="">
            Select listing…
          </option>
          {allListings.map((listing) => (
            <option selected={listing.id === line.listingId} value={listing.id}>
              {listing.name}
              {listing.active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
        {(line.existingBooking?.checked_in ||
          line.existingBooking?.refunded) && (
          <div class="muted small">
            {line.existingBooking?.checked_in ? (
              <span class="badge">Checked in</span>
            ) : null}
            {line.existingBooking?.checked_in && line.existingBooking?.refunded
              ? " "
              : null}
            {line.existingBooking?.refunded ? (
              <span class="badge danger">Refunded</span>
            ) : null}
          </div>
        )}
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
            <th>Listing</th>
            <th>Date</th>
            <th>Qty</th>
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

/** Render the bulk-email contact history (edit mode only, attendee has an
 * email). Shows a placeholder when the attendee has never been contacted. */
const EmailHistory = ({
  emailStats,
}: {
  emailStats: EmailStats | null;
}): JSX.Element => (
  <article>
    <h3>Email History</h3>
    {emailStats && emailStats.contactCount > 0 ? (
      <ul>
        <li>
          <strong>Total messages:</strong> {emailStats.contactCount}
        </li>
        <li>
          <strong>Last contacted:</strong>{" "}
          {formatDatetimeShort(emailStats.lastContact)}
        </li>
        <li>
          <strong>Last subject:</strong> {emailStats.lastSubject}
        </li>
      </ul>
    ) : (
      <p>Never contacted by bulk email.</p>
    )}
  </article>
);

/** Render the "Merge Attendee" section (edit mode only). */
const MergeSection = ({ attendee }: { attendee: Attendee }): JSX.Element => (
  <article>
    <h3>Merge Attendee</h3>
    <p>
      Search for another attendee by their ticket token and merge their listing
      registrations into this attendee.
    </p>
    <form
      action={`/admin/attendees/${attendee.id}/merge`}
      class="inline-row"
      method="get"
    >
      <label for="merge_token">
        Ticket token
        <input
          id="merge_token"
          name="token"
          placeholder="Enter ticket token…"
          required
          type="text"
        />
      </label>
      <SubmitButton icon="search">Search</SubmitButton>
    </form>
  </article>
);

/** Page title for the layout. */
const pageTitle = (data: AttendeeFormTemplateData): string =>
  data.mode === "create"
    ? "Add Attendee"
    : `Edit Attendee: ${data.attendee!.name}`;

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
  return `<script type="application/json" id="attendee-form-data" data-available-dates='${escapeHtml(availableDatesJson)}' data-listing-types='${escapeHtml(listingTypesJson)}'></script>
  <script>
    (function () {
      var dataEl = document.getElementById('attendee-form-data');
      if (!dataEl) return;
      var availableDates = JSON.parse(dataEl.getAttribute('data-available-dates') || '{}');
      var listingTypes = JSON.parse(dataEl.getAttribute('data-listing-types') || '{}');
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
  const formAction =
    data.mode === "create"
      ? "/admin/attendees/new"
      : `/admin/attendees/${data.attendee!.id}`;
  const isEdit = data.mode === "edit";
  const a = data.attendee;

  return String(
    <Layout title={pageTitle(data)}>
      <AdminNav active="/admin/" session={session} />

      <h2>{pageTitle(data)}</h2>

      {isEdit && a && <Raw html={PaymentDetails({ attendee: a })} />}

      {data.attendeeError && (
        <div class="error" role="alert">
          {data.attendeeError}
        </div>
      )}

      {data.dailyDefaults.hasMixedTimings && (
        <output class="warning">
          This attendee's existing daily listings have different start dates or
          durations. You can still add daily lines, but they won't inherit a
          shared default — pick the date explicitly for each new line.
        </output>
      )}

      <CsrfForm action={formAction} id={ATTENDEE_FORM_ID}>
        <Flash error={data.flashError} success={data.flashSuccess} />
        {data.returnUrl && (
          <input name="return_url" type="hidden" value={data.returnUrl} />
        )}

        <h3>Attendee Details</h3>

        <label for="name">
          Name
          <input
            autofocus
            id="name"
            name="name"
            required
            type="text"
            value={data.parsed.name}
          />
        </label>

        <label for="email">
          Email
          <input
            id="email"
            name="email"
            type="email"
            value={data.parsed.email || ""}
          />
        </label>

        <label for="phone">
          Phone
          <input
            id="phone"
            name="phone"
            pattern="[+\d][\d\s\-()]{5,}"
            title="Phone number (digits, spaces, hyphens, parentheses, optional leading +)"
            type="text"
            value={data.parsed.phone || ""}
          />
        </label>

        <label for="address">
          Address
          <textarea id="address" maxlength={250} name="address" rows={3}>
            {data.parsed.address || ""}
          </textarea>
        </label>

        <label for="special_instructions">
          Special Instructions
          <textarea
            id="special_instructions"
            maxlength={250}
            name="special_instructions"
            rows={3}
          >
            {data.parsed.special_instructions || ""}
          </textarea>
        </label>

        {data.questions && data.questions.length > 0 && (
          <>
            <h3>Custom Questions</h3>
            <EditQuestions
              questions={data.questions}
              selectedAnswerIds={data.selectedAnswerIds}
            />
          </>
        )}

        <h3>Listing Registrations</h3>
        <LineEditor data={data} />
        <p>
          <button
            formnovalidate
            name={ACTION_FIELD}
            type="submit"
            value={ADD_LINE_ACTION}
          >
            <Icon name="plus" />
            <span>Add Listing Line</span>
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
            <span>{isEdit ? "Save Attendee" : "Create Attendee"}</span>
          </button>
          <a class="button" href={data.returnUrl || "/admin/"}>
            Back without saving
          </a>
        </p>
      </CsrfForm>

      {isEdit && a && a.email && (
        <EmailHistory emailStats={data.emailStats ?? null} />
      )}

      {isEdit && a && <MergeSection attendee={a} />}

      <Raw html={renderEnhancementScript(data)} />
    </Layout>,
  );
};
