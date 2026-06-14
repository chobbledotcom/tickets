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
import { formatCurrency } from "#shared/currency.ts";
import { formatDateRangeLabel } from "#shared/dates.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminSession,
  Attendee,
  ListingWithCount,
} from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
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
};

/** Render a single <option> for the listing selector. */
const renderListingOption = (
  listing: ListingWithCount,
  selectedId: number,
): string => {
  const selected = listing.id === selectedId ? " selected" : "";
  const dimmed = listing.active ? "" : " (inactive)";
  return `<option value="${listing.id}"${selected}>${escapeHtml(listing.name)}${dimmed}</option>`;
};

/** Build the listing-selector <select> HTML for one line. */
const renderListingSelect = (
  line: AttendeeFormLine,
  allListings: ListingWithCount[],
  index: number,
): string => {
  const options = allListings
    .map((listing) => renderListingOption(listing, line.listingId))
    .join("");
  const placeholder = `<option value=""${line.listingId === 0 ? " selected" : ""}>Select event…</option>`;
  return `<select name="${LINE_EVENT_ID_PREFIX}${index}" aria-label="Event for line ${index + 1}" data-line-event>${placeholder}${options}</select>`;
};

/** Render the date input for one line. */
const renderDateInput = (line: AttendeeFormLine, index: number): string => {
  const isDaily = line.listing?.listing_type === "daily" || !line.listing;
  const value = line.date ? escapeHtml(line.date) : "";
  // The date field is never required at the HTML level — the server
  // validates it conditionally for daily listings. Hidden when a listing is
  // picked and that listing is non-daily (handled by the inline script).
  return `<input type="date" name="${LINE_DATE_PREFIX}${index}" value="${value}" aria-label="Date for line ${index + 1}" data-line-date${isDaily ? "" : " hidden"}>`;
};

/** Render one line-item row. */
const renderLineRow = (
  line: AttendeeFormLine,
  index: number,
  allListings: ListingWithCount[],
): string => {
  const qty = line.quantity === null ? "" : String(line.quantity);
  // Only emit max when a listing is chosen — an empty max="" is meaningless.
  const maxAttr = line.listing ? ` max="${line.listing.max_quantity}"` : "";
  const errorHtml = line.error
    ? `<div class="error" role="alert">${escapeHtml(line.error)}</div>`
    : "";
  const removeLabel = line.existingBooking ? "Remove" : "Drop";
  // Show the existing booking status (checked-in / refunded) inline so the
  // operator has the same context the old edit page provided.
  const statusBadges: string[] = [];
  if (line.existingBooking?.checked_in) {
    statusBadges.push(`<span class="badge">Checked in</span>`);
  }
  if (line.existingBooking?.refunded) {
    statusBadges.push(`<span class="badge danger">Refunded</span>`);
  }
  const statusHtml = statusBadges.length
    ? `<div class="muted small">${statusBadges.join(" ")}</div>`
    : "";

  return `<tr data-line-row>
    <td>${renderListingSelect(line, allListings, index)}${statusHtml}</td>
    <td>${renderDateInput(line, index)}</td>
    <td><input type="number" name="${LINE_QUANTITY_PREFIX}${index}" value="${escapeHtml(qty)}" min="1"${maxAttr} aria-label="Quantity for line ${index + 1}" style="width:5em"></td>
    <td>${renderExistingDateLabel(line)}${errorHtml}</td>
    <td style="white-space:nowrap">
      <input type="hidden" name="${LINE_KEY_PREFIX}${index}" value="${escapeHtml(line.key)}">
      <button class="link-button danger" type="submit" name="${ACTION_FIELD}" value="${REMOVE_LINE_ACTION_PREFIX}${index}" formnovalidate>${removeLabel}</button>
    </td>
  </tr>`;
};

/** Friendly label for an existing booking's stored date range. */
const renderExistingDateLabel = (line: AttendeeFormLine): string => {
  if (!line.existingBooking?.start_at) return "";
  const label = formatDateRangeLabel(
    line.existingBooking.start_at,
    line.existingBooking.end_at,
  );
  return `<div class="muted small">${escapeHtml(label)}</div>`;
};

/** Render the line-item editor table. */
const renderLineEditor = (data: AttendeeFormTemplateData): string => {
  const rows = data.parsed.lines
    .map((line, index) => renderLineRow(line, index, data.allListings))
    .join("");
  return `<div class="table-scroll">
    <table class="line-editor">
      <thead>
        <tr>
          <th>Event</th>
          <th>Date</th>
          <th>Qty</th>
          <th></th>
          <th style="width:1%"></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <input type="hidden" name="${LINE_COUNT_FIELD}" value="${data.parsed.lines.length}">`;
};

/** Render the mixed-timing alert (non-blocking). */
const renderMixedTimingAlert = (data: AttendeeFormTemplateData): string => {
  if (!data.dailyDefaults.hasMixedTimings) return "";
  return String(
    <output class="warning">
      This attendee's existing daily events have different start dates or
      durations. You can still add daily lines, but they won't inherit a shared
      default — pick the date explicitly for each new line.
    </output>,
  );
};

/** Render the read-only payment-details section (edit mode only). */
const renderPaymentDetails = (attendee: Attendee): string => {
  if (!attendee.payment_id) return "";
  const pricePaid = Number.parseInt(attendee.price_paid, 10);
  const isRefunded = attendee.refunded;
  const refundBadge = isRefunded
    ? '<span class="badge-alert">Refunded</span>'
    : "Not refunded";
  return String(
    <article>
      <h3>Payment Details</h3>
      <p>
        <strong>Payment ID:</strong> {attendee.payment_id}
      </p>
      {pricePaid > 0 && (
        <p>
          <strong>Amount Paid:</strong> {formatCurrency(attendee.price_paid)}
        </p>
      )}
      <p>
        <strong>Refund Status:</strong> <Raw html={refundBadge} />
      </p>
      <CsrfForm
        action={`/admin/attendees/${attendee.id}/refresh-payment`}
        class="inline"
      >
        <button type="submit">Refresh payment status</button>
      </CsrfForm>
    </article>,
  );
};

/** Render the "Merge Attendee" section (edit mode only). */
const renderMergeSection = (attendee: Attendee): string =>
  String(
    <article>
      <h3>Merge Attendee</h3>
      <p>
        Search for another attendee by their ticket token and merge their event
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
        <button type="submit">Search</button>
      </form>
    </article>,
  );

/** Render custom question fields with pre-selected answers for admin edit. */
const renderEditQuestions = (
  questions: QuestionWithAnswers[],
  selectedAnswerIds: number[],
): string => {
  const checked = (id: number) =>
    selectedAnswerIds.includes(id) ? " checked" : "";
  const questionHtml = questions
    .map((q) => {
      const options = q.answers
        .map(
          (a) =>
            `<label><input type="radio" name="question_${q.id}" value="${a.id}"${checked(a.id)}> ${escapeHtml(a.text)}</label>`,
        )
        .join("");
      return `<fieldset class="custom-question"><legend>${escapeHtml(q.text)}</legend>${options}</fieldset>`;
    })
    .join("");
  return `<h3>Custom Questions</h3>${questionHtml}`;
};

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
  const eventsByTypeJson = JSON.stringify(listingsByType);
  return `<script type="application/json" id="attendee-form-data" data-available-dates='${escapeHtml(availableDatesJson)}' data-event-types='${escapeHtml(eventsByTypeJson)}'></script>
  <script>
    (function () {
      var dataEl = document.getElementById('attendee-form-data');
      if (!dataEl) return;
      var availableDates = JSON.parse(dataEl.getAttribute('data-available-dates') || '{}');
      var eventTypes = JSON.parse(dataEl.getAttribute('data-event-types') || '{}');
      function updateRow(row) {
        var select = row.querySelector('[data-line-event]');
        var dateInput = row.querySelector('[data-line-date]');
        if (!select || !dateInput) return;
        var eventId = Number(select.value);
        var isDaily = eventTypes[eventId] === 'daily';
        dateInput.hidden = !isDaily;
        if (isDaily && !dateInput.value) {
          var dates = availableDates[eventId] || [];
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
  const nameValue = data.parsed.name;
  const isEdit = data.mode === "edit";
  const a = data.attendee;

  return String(
    <Layout title={pageTitle(data)}>
      <AdminNav active="/admin/" session={session} />

      <h2>{pageTitle(data)}</h2>

      {isEdit && a && <Raw html={renderPaymentDetails(a)} />}

      {data.attendeeError && (
        <div class="error" role="alert">
          {data.attendeeError}
        </div>
      )}

      <Raw html={renderMixedTimingAlert(data)} />

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
            value={nameValue}
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
          <Raw
            html={renderEditQuestions(data.questions, data.selectedAnswerIds)}
          />
        )}

        <h3>Event Registrations</h3>
        <Raw html={renderLineEditor(data)} />
        <p>
          <button
            formnovalidate
            name={ACTION_FIELD}
            type="submit"
            value={ADD_LINE_ACTION}
          >
            Add Event Line
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
            {isEdit ? "Save Attendee" : "Create Attendee"}
          </button>
          <a class="button" href={data.returnUrl || "/admin/"}>
            Back without saving
          </a>
        </p>
      </CsrfForm>

      {isEdit && a && <Raw html={renderMergeSection(a)} />}

      <Raw html={renderEnhancementScript(data)} />
    </Layout>,
  );
};
