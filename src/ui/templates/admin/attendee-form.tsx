/**
 * Unified add/edit attendee page template.
 *
 * Renders the same form for `/admin/attendees/new` (create) and
 * `/admin/attendees/:id` (edit). An attendee has ONE shared date range — a
 * start date plus a length — applied to every daily listing they book. The
 * listing editor is a fixed table with one quantity box per bookable listing
 * (plus any inactive listing the attendee already booked); quantity ≥ 1 books
 * it, 0 leaves it out, so there are no add/remove-line buttons. When something
 * is already booked (an edit, or a create pre-filled from the calendar) the
 * not-booked rows hide behind a "Show all listings" toggle (pure CSS); a bare
 * create form has nothing booked, so it drops the toggle and shows every
 * listing. The form works without JavaScript.
 */

import { compact } from "#fp";
import { t } from "#i18n";
import {
  ATTENDEE_FORM_ID,
  type AttendeeFormLine,
  type BalanceNotice,
  DAY_COUNT_FIELD,
  isBookedLine,
  LINE_KEY_PREFIX,
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
import { targetQuery } from "#shared/bulk-email.ts";
import { toMajorUnits } from "#shared/currency.ts";
import {
  addDays,
  formatDateLabel,
  formatDateRangeLabel,
  formatDatetimeShort,
} from "#shared/dates.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { ContactRecord } from "#shared/db/contact-preferences.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { START_DATE_FIELD } from "#shared/order-select.ts";
import {
  type AdminSession,
  type Attendee,
  MAX_DURATION_DAYS,
} from "#shared/types.ts";
import {
  AttendeeAnswersTable,
  AttendeeDetail,
  AttendeeLogSection,
} from "#templates/admin/attendee-detail.tsx";
import { EditQuestions, PaymentDetails } from "#templates/admin/attendees.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  ActionButton,
  Icon,
  MaybeButtonLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

/** One channel's contact record plus the URL-safe HMAC param that keys its
 * /admin/history editor link. Null when the attendee has no value for that
 * channel. */
export type ContactChannelData = { hashParam: string; record: ContactRecord };

/** Per-channel contact records shown in the read-only history panel. */
export type ContactRecordsByChannel = {
  email: ContactChannelData | null;
  phone: ContactChannelData | null;
};

/** Template data for the unified attendee form. */
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
  /** Save outcome shown inside the form. */
  flashError?: string;
  flashSuccess?: string;
  /** Custom questions across the attendee's booked listings. */
  questions: QuestionWithAnswers[];
  /** Currently-selected answer ids for the rendered questions. */
  selectedAnswerIds: number[];
  /** Currently-entered free-text answers, keyed by question id. */
  selectedTextAnswers: Map<number, string>;
  /** Today's ISO date. */
  todayIso: string;
  /** Optional return URL the caller came from. */
  returnUrl?: string;
  /** Contact history by channel (edit mode only). */
  contactRecords: ContactRecordsByChannel;
  /** Public site domain, for the read-only ticket link (edit mode). */
  allowedDomain: string;
  /** Country dialling code, for the read-only phone links. */
  phonePrefix: string;
  /** This attendee's activity log entries, newest first (edit mode only). */
  activityLog: ActivityLogEntry[];
  /** Overbooking / over-duration warnings per listing id (booked lines only). */
  lineWarnings: Map<number, string[]>;
  /** All warnings flattened, for the top-of-page summary. */
  topWarnings: string[];
  /** Logistics selectors data, or undefined when logistics doesn't apply. */
  logistics?: AttendeeLogisticsData;
};

/** Status badges for an existing booking — "Checked in" and/or "Refunded". */
const bookingStatusBadges = (
  booking: AttendeeFormLine["existingBooking"],
): JSX.Element | null => {
  const badges = compact([
    booking?.checked_in ? <span class="badge">Checked in</span> : null,
    booking?.refunded ? <span class="badge danger">Refunded</span> : null,
  ]);
  return badges.length > 0 ? (
    <div class="muted small">
      <Raw html={badges.join(" ")} />
    </div>
  ) : null;
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
  const booked = isBookedLine(line) || Boolean(line.existingBooking);
  const isDaily = listing.listing_type === "daily";
  return (
    <tr class={booked ? "attendee-line" : "attendee-line attendee-line-empty"}>
      <td>
        <a href={`/admin/listing/${listing.id}`}>{listing.name}</a>
        {listing.active ? "" : <span class="muted small">(inactive)</span>}
        {bookingStatusBadges(line.existingBooking)}
      </td>
      <td>
        {isDaily ? (
          <span class="muted small">Shared dates</span>
        ) : (
          <span class="muted small">Fixed date</span>
        )}
      </td>
      <td>
        <input
          aria-label={`Quantity for ${listing.name}`}
          max={listing.max_quantity}
          min="0"
          name={`${QTY_PREFIX}${listing.id}`}
          style="width:5em"
          type="number"
          value={line.quantity === null ? "0" : String(line.quantity)}
        />
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
    (line) => isBookedLine(line) || Boolean(line.existingBooking),
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
          Show all listings
        </label>
      )}
      <div class="table-scroll">
        <table class="line-editor">
          <thead>
            <tr>
              <th>Listing</th>
              <th>Dates</th>
              <th>Qty</th>
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
  const label = isStart ? "Start time & agent:" : "End time & agent:";
  const time = isStart ? assignment.startTime : assignment.endTime;
  const agentId = isStart ? assignment.startAgentId : assignment.endAgentId;
  return (
    <div class="logistics-leg">
      <span class="logistics-leg-label">{label}</span>
      <input
        aria-label={isStart ? "Start time" : "End time"}
        name={(isStart ? startTimeField : endTimeField)(listingId)}
        type="time"
        value={time}
      />
      <select
        aria-label={isStart ? "Start agent" : "End agent"}
        class="logistics-leg-agent"
        name={(isStart ? startAgentField : endAgentField)(listingId)}
      >
        <option selected={agentId === null} value="">
          — None —
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
      <legend>Logistics</legend>
      <label class="split-agents">
        <input
          checked={logistics.split}
          class="split-agents-toggle"
          name={SPLIT_AGENTS_FIELD}
          type="checkbox"
          value="1"
        />
        Use different agents per item
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
      ? `${n} day${n === 1 ? "" : "s"}: ${formatDateLabel(
          addDays(startDate, n - 1),
        )}`
      : `${n} day${n === 1 ? "" : "s"}`;
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
      <h3>Dates</h3>
      <p class="small">
        Optional — the date only affects daily listings. A start date is
        required once you book a daily listing below.
      </p>
      {data.dateError && (
        <output class="error" role="alert">
          {data.dateError}
        </output>
      )}
      <label for={START_DATE_FIELD}>
        Start date
        <input
          id={START_DATE_FIELD}
          name={START_DATE_FIELD}
          type="date"
          value={data.parsed.startDate}
        />
      </label>
      <output class="warning" data-availability-notice hidden={noticeHidden}>
        Availability is inaccurate until dates have been saved.
      </output>
      <label data-day-count-label for={DAY_COUNT_FIELD}>
        Length
        <select id={DAY_COUNT_FIELD} name={DAY_COUNT_FIELD}>
          {dayCountOptions(data.parsed.startDate, data.parsed.dayCount)}
        </select>
      </label>
    </>
  );
};

/** Render one channel's contact record: the per-source booking/message counts,
 * the markdown-rendered private note, and an Edit link to its history page. */
const ContactRecordSection = ({
  channel,
  label,
}: {
  channel: ContactChannelData;
  label: string;
}): JSX.Element => {
  const { hashParam, record } = channel;
  return (
    <section>
      <h4>{label}</h4>
      <ul>
        <li>
          <strong>{t("attendee_form.online_bookings")}:</strong>{" "}
          {record.publicBookingCount}
        </li>
        <li>
          <strong>{t("attendee_form.admin_bookings")}:</strong>{" "}
          {record.adminBookingCount}
        </li>
        <li>
          <strong>{t("attendee_form.total_messages")}:</strong>{" "}
          {record.contactCount}
        </li>
        {record.lastContact && (
          <li>
            <strong>{t("attendee_form.last_contacted")}:</strong>{" "}
            {formatDatetimeShort(record.lastContact)}
          </li>
        )}
        {record.lastSubject && (
          <li>
            <strong>{t("attendee_form.last_subject")}:</strong>{" "}
            {record.lastSubject}
          </li>
        )}
      </ul>
      {record.adminNotes && (
        <div class="contact-notes">
          <Raw html={renderMarkdown(record.adminNotes)} />
        </div>
      )}
      <p>
        <a href={`/admin/history/${hashParam}`}>
          {t("attendee_form.edit_contact_record")}
        </a>
      </p>
    </section>
  );
};

/** Render contact history for each available channel (edit mode only). */
const ContactHistory = ({
  attendee,
  contactRecords,
  isOwner,
}: {
  attendee: Attendee;
  contactRecords: ContactRecordsByChannel;
  isOwner: boolean;
}): JSX.Element => {
  const hasEmail = Boolean(attendee.email);
  return (
    <article>
      <h3>{t("attendee_form.contact_history")}</h3>
      {contactRecords.email ? (
        <ContactRecordSection
          channel={contactRecords.email}
          label={t("attendee_form.stats_for", { value: attendee.email })}
        />
      ) : (
        <p>{t("attendee_form.no_email_on_file")}</p>
      )}
      {contactRecords.phone ? (
        <ContactRecordSection
          channel={contactRecords.phone}
          label={t("attendee_form.stats_for", { value: attendee.phone })}
        />
      ) : (
        <p>{t("attendee_form.no_phone_on_file")}</p>
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

/** An attendee is refundable when they have a captured payment that has not
 * already been refunded. */
const isRefundable = (attendee: Attendee): boolean =>
  !!attendee.payment_id && !attendee.refunded;

/**
 * Per-attendee actions (edit mode only) — refund, re-send notification, and
 * delete. These used to live in the attendee table's "Actions" column; they now
 * sit on the edit page, each routed through its own typed-name confirmation
 * page. The booking-scoped routes are keyed on the attendee's home listing.
 */
const AttendeeActions = ({ attendee }: { attendee: Attendee }): JSX.Element => {
  const base = `/admin/listing/${attendee.listing_id}/attendee/${attendee.id}`;
  const ret = `?return_url=${encodeURIComponent(
    `/admin/attendees/${attendee.id}`,
  )}`;
  return (
    <article>
      <h3>Actions</h3>
      <p class="actions">
        {isRefundable(attendee) && (
          <ActionButton
            href={`${base}/refund${ret}`}
            icon="credit-card"
            variant="secondary"
          >
            Refund
          </ActionButton>
        )}
        <ActionButton
          href={`${base}/resend-notification${ret}`}
          icon="rotate-ccw"
          variant="secondary"
        >
          Re-send notification
        </ActionButton>
        <ActionButton
          href={`/admin/sms?listing=${attendee.listing_id}&attendee=${attendee.id}`}
          icon="arrow-right"
          variant="secondary"
        >
          Send text
        </ActionButton>
        <ActionButton
          href={`${base}/delete`}
          icon="trash-2"
          variant="secondary"
        >
          Delete attendee
        </ActionButton>
      </p>
    </article>
  );
};

/** Render the "Merge Attendee" section (edit mode only). */
const MergeSection = ({ attendee }: { attendee: Attendee }): JSX.Element => (
  <article>
    <div class="prose">
      <h3>Merge Attendee</h3>
      <p>
        Search for another attendee by their ticket token and merge their
        listing registrations into this attendee.
      </p>
    </div>
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
    ? "Add new attendee"
    : `Attendee: ${data.attendee!.name}`;

/** The attendee's current status as an `<h2>`, shown only with >1 status. */
const StatusHeading = ({
  data,
}: {
  data: AttendeeFormTemplateData;
}): JSX.Element | null => {
  if (data.mode !== "edit" || !data.attendee || data.statuses.length <= 1) {
    return null;
  }
  const status = data.statuses.find((s) => s.id === data.attendee!.status_id);
  return <h2>Status: {status ? status.name : "None"}</h2>;
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
      <h3>Status &amp; Balance</h3>
      {data.balanceNotice && (
        <output class={data.balanceNotice.tone}>
          {data.balanceNotice.message}
        </output>
      )}
      {data.statuses.length <= 1 ? (
        <input name={STATUS_FIELD} type="hidden" value={selectedId} />
      ) : (
        <label for={STATUS_FIELD}>
          Status
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
        Outstanding balance
        <input
          id={REMAINING_BALANCE_FIELD}
          inputmode="decimal"
          min="0"
          name={REMAINING_BALANCE_FIELD}
          step="0.01"
          type="number"
          value={toMajorUnits(remainingBalance)}
        />
        <small>
          What the attendee still owes. Set to 0 when fully paid; the public
          payment link clears it automatically when they pay.
        </small>
      </label>
    </>
  );
};

/**
 * The editable attendee form: contact details, the shared date range, optional
 * custom questions, and the listing editor — all inside one CsrfForm.
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

      {!isEdit && <h3>Attendee Details</h3>}

      <label for="name">
        Name
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
        Email
        <input
          autocomplete="off"
          id="email"
          name="email"
          type="email"
          value={data.parsed.email || ""}
        />
      </label>

      <label for="phone">
        Phone
        <input
          autocomplete="off"
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
        Special Instructions
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
          <h3>Custom Questions</h3>
          <EditQuestions
            questions={data.questions}
            selectedAnswerIds={data.selectedAnswerIds}
            selectedTextAnswers={data.selectedTextAnswers}
          />
        </>
      )}

      <SharedDateFields data={data} />

      <h3>Listing Registrations</h3>
      {data.hasMixedTimings && (
        <output class="warning">
          This attendee's existing daily listings have different start dates or
          lengths. Saving will put them all on the one date range above.
        </output>
      )}
      <ListingEditor data={data} />

      <LogisticsSection data={data} />

      <hr />

      <p class="form-actions">
        <button class="primary" type="submit">
          <Icon name="save" />
          <span>{isEdit ? "Save Attendee" : "Create Attendee"}</span>
        </button>
      </p>
    </CsrfForm>
  );
};

/**
 * Render the unified attendee form page (create or edit). In edit mode the
 * read-only summary is the primary view and the form sits in a collapsed
 * disclosure; in create mode the form is the page.
 */
export const attendeeFormPage = (
  data: AttendeeFormTemplateData,
  session: AdminSession,
): string => {
  const isEdit = data.mode === "edit";
  const a = data.attendee;
  const editForm = <AttendeeEditForm data={data} />;

  return String(
    <Layout title={pageTitle(data)}>
      <AdminNav active="/admin/attendees" session={session} />

      <div class="prose">
        <h1>{pageTitle(data)}</h1>
        <StatusHeading data={data} />
      </div>

      {data.topWarnings.length > 0 && (
        <output class="warning" role="alert">
          <strong>Please double-check:</strong>
          <ul>
            {data.topWarnings.map((w) => (
              <li>{w}</li>
            ))}
          </ul>
        </output>
      )}

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

      {isEdit && a && <AttendeeActions attendee={a} />}

      {isEdit && <AttendeeLogSection entries={data.activityLog} />}

      {data.attendeeError && (
        <div class="error" role="alert">
          {data.attendeeError}
        </div>
      )}

      {isEdit ? (
        <details>
          <summary>Edit Attendee Details</summary>
          {editForm}
        </details>
      ) : (
        editForm
      )}

      {isEdit && a && (
        <ContactHistory
          attendee={a}
          contactRecords={data.contactRecords}
          isOwner={session.adminLevel === "owner"}
        />
      )}

      {isEdit && a && <MergeSection attendee={a} />}
    </Layout>,
  );
};
