/**
 * Admin event page templates - detail, edit, delete
 */

import { filter, joinStrings, map, pipe } from "#fp";
import { toMajorUnits } from "#lib/currency.ts";
import {
  formatDateLabel,
  formatDatetimeLabel,
  formatDatetimeShort,
} from "#lib/dates.ts";
import { settings } from "#lib/db/settings.ts";
import { buildEmbedSnippets } from "#lib/embed.ts";
import { isReadOnly } from "#lib/env.ts";
import type { Field } from "#lib/forms.tsx";
import {
  ConfirmForm,
  CsrfForm,
  type FieldValues,
  Flash,
  renderField,
  renderFields,
} from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { isStorageEnabled } from "#lib/storage.ts";
import { utcToLocalInput } from "#lib/timezone.ts";
import {
  type AdminSession,
  type Attendee,
  type EventWithCount,
  type Group,
  isPaidEvent,
} from "#lib/types.ts";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { formatCountdown } from "#routes/format.ts";
import { buildSharedDetailRows } from "#templates/admin/detail-rows.tsx";
import { EventGroupSelect } from "#templates/admin/group-select.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  AttendeeTable,
  type AttendeeTableRow,
  type TableQuestionData,
} from "#templates/attendee-table.tsx";
import {
  assignBuiltSiteField,
  attachmentField,
  eventFields,
  getAddAttendeeFields,
  imageField,
  slugField,
} from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { renderEventImage } from "#templates/public.tsx";

/** Date option for the date filter dropdown */
export type DateOption = { value: string; label: string };

/** Attendee filter type */
export type AttendeeFilter = "all" | "in" | "out";

/** Re-export shared detail functions for backwards compatibility */
export {
  calculateTotalRevenue,
  countCheckedIn,
  countCheckedInRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";
/** Re-export formatAddressInline from shared module for backwards compatibility */
export { formatAddressInline } from "#templates/attendee-table.tsx";

import {
  buildAnswerSummaryRows as buildAnswerSummaryDetailRows,
  renderDetailRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";

/** Build answer count summary rows as an HTML string of <tr> elements */
export const buildAnswerSummaryRows = (
  questionData: TableQuestionData | undefined,
): string => renderDetailRows(buildAnswerSummaryDetailRows(questionData));

/** Check if event is within 10% of capacity */
export const nearCapacity = (event: EventWithCount): boolean =>
  event.attendee_count >= event.max_attendees * 0.9;

/**
 * Check if an attendee has an incomplete/failed payment.
 * True when the event is paid, the attendee has no payment reference,
 * but was charged a non-zero price (distinguishing from admin-added attendees
 * who have price_paid=0).
 */
export const isIncompletePayment = (
  attendee: Attendee,
  hasPaidEvent: boolean,
): boolean =>
  hasPaidEvent &&
  !attendee.payment_id &&
  Number.parseInt(attendee.price_paid, 10) > 0;

/** Render a single row in the Failed Payments table */
const FailedPaymentRow = ({
  attendee,
  eventId,
}: {
  attendee: Attendee;
  eventId: number;
}): string =>
  String(
    <tr>
      <td>{attendee.name}</td>
      <td>{attendee.quantity}</td>
      <td>{formatDatetimeShort(attendee.created)}</td>
      <td>
        <CsrfForm
          action={`/admin/event/${eventId}/attendee/${attendee.id}/delete-incomplete`}
          class="inline"
        >
          <button class="link-button danger" type="submit">
            Delete
          </button>
        </CsrfForm>
      </td>
    </tr>,
  );

/** Render a table of attendees with failed/incomplete payments */
const FailedPaymentsTable = ({
  attendees,
  eventId,
}: {
  attendees: Attendee[];
  eventId: number;
}): string =>
  String(
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Qty</th>
          <th>Registered</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <Raw
          html={pipe(
            map((a: Attendee) => FailedPaymentRow({ attendee: a, eventId })),
            joinStrings,
          )(attendees)}
        />
      </tbody>
    </table>,
  );

/** Check-in message to display after toggling */
export type CheckinMessage = { name: string; status: string } | null;

/** Filter attendees by check-in status */
const filterAttendees = (
  attendees: Attendee[],
  activeFilter: AttendeeFilter,
): Attendee[] => {
  if (activeFilter === "in") {
    return filter((a: Attendee) => a.checked_in)(attendees);
  }
  if (activeFilter === "out") {
    return filter((a: Attendee) => !a.checked_in)(attendees);
  }
  return attendees;
};

/** Render a filter link, bold if active */
const FilterLink = ({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}): string =>
  active
    ? String(<strong>{label}</strong>)
    : String(<a href={href}>{label}</a>);

/** Build the path suffix for a checkin filter (preserves date query) */
const filterSuffix = (activeFilter: AttendeeFilter): string =>
  activeFilter === "all" ? "" : `/${activeFilter}`;

/** Date selector dropdown for daily events */
const DateSelector = ({
  basePath,
  activeFilter,
  dateFilter,
  dates,
}: {
  basePath: string;
  activeFilter: AttendeeFilter;
  dateFilter: string | null;
  dates: DateOption[];
}): string => {
  const suffix = filterSuffix(activeFilter);
  const options = [
    `<option value="${basePath}${suffix}#attendees"${
      !dateFilter ? " selected" : ""
    }>All dates</option>`,
    ...dates.map(
      (d) =>
        `<option value="${basePath}${suffix}?date=${d.value}#attendees"${
          dateFilter === d.value ? " selected" : ""
        }>${d.label}</option>`,
    ),
  ].join("");
  return `<select data-nav-select aria-label="Filter by date">${options}</select>`;
};

/** Options for rendering the admin event detail page */
export type AdminEventPageOptions = {
  event: EventWithCount;
  attendees: Attendee[];
  allowedDomain: string;
  session: AdminSession;
  checkinMessage?: CheckinMessage;
  activeFilter?: AttendeeFilter;
  dateFilter?: string | null;
  availableDates?: DateOption[];
  errorMessage?: string;
  phonePrefix?: string;
  successMessage?: string;
  questionData?: TableQuestionData;
};

/** Top action nav for the event detail page */
const EventActionNav = ({
  event,
  dateFilter,
  hasPaidEvent,
}: {
  event: EventWithCount;
  dateFilter: string | null;
  hasPaidEvent: boolean;
}): JSX.Element => {
  const readOnly = isReadOnly();
  return (
    <nav>
      <ul>
        {!readOnly && (
          <li>
            <a href={`/admin/event/${event.id}/edit`}>Edit</a>
          </li>
        )}
        {!readOnly && (
          <li>
            <a href={`/admin/event/${event.id}/duplicate`}>Duplicate</a>
          </li>
        )}
        <li>
          <a href={`/admin/event/${event.id}/log`}>Log</a>
        </li>
        {!event.purchase_only && (
          <li>
            <a href={`/admin/event/${event.id}/scanner`}>Scanner</a>
          </li>
        )}
        <li>
          <a href={`/admin/event/${event.id}/questions`}>Questions</a>
        </li>
        {!readOnly && (
          <li>
            <a href={`/admin/event/${event.id}/qr`}>Booking QR</a>
          </li>
        )}
        <li>
          <a
            href={`/admin/event/${event.id}/export${
              dateFilter ? `?date=${dateFilter}` : ""
            }`}
          >
            Export CSV
          </a>
        </li>
        {hasPaidEvent && (
          <li>
            <a class="danger" href={`/admin/event/${event.id}/refund-all`}>
              Refund All
            </a>
          </li>
        )}
        {event.active ? (
          <li>
            <a class="danger" href={`/admin/event/${event.id}/deactivate`}>
              Deactivate
            </a>
          </li>
        ) : (
          <li>
            <a href={`/admin/event/${event.id}/reactivate`}>Reactivate</a>
          </li>
        )}
        <li>
          <a class="danger" href={`/admin/event/${event.id}/delete`}>
            Delete
          </a>
        </li>
      </ul>
    </nav>
  );
};

/** Daily-specific schedule rows (bookable days, booking window) */
const DailyScheduleRows = ({
  event,
}: {
  event: EventWithCount;
}): JSX.Element => (
  <>
    <tr>
      <th>Bookable Days</th>
      <td>{formatBookableDays(event.bookable_days)}</td>
    </tr>
    <tr>
      <th>Booking Window</th>
      <td>
        {event.minimum_days_before} to{" "}
        {event.maximum_days_after === 0
          ? "unlimited"
          : event.maximum_days_after}{" "}
        days from today
      </td>
    </tr>
  </>
);

/** Attendee count cell content (varies by daily/date-filter state) */
const AttendeeCountDisplay = ({
  event,
  isDaily,
  dateFilter,
  adjustedCount,
  completeQuantitySum,
}: {
  event: EventWithCount;
  isDaily: boolean;
  dateFilter: string | null;
  adjustedCount: number;
  completeQuantitySum: number;
}): JSX.Element => {
  if (isDaily && dateFilter) {
    const overCap = completeQuantitySum >= event.max_attendees;
    return (
      <span class={overCap ? "danger-text" : ""}>
        {completeQuantitySum} / {event.max_attendees} &mdash;{" "}
        {event.max_attendees - completeQuantitySum} remain
      </span>
    );
  }
  const nearCap = adjustedCount >= event.max_attendees * 0.9;
  return (
    <span class={nearCap ? "danger-text" : ""}>
      {adjustedCount}
      {!isDaily && (
        <>
          {" "}
          / {event.max_attendees} &mdash; {event.max_attendees - adjustedCount}{" "}
          remain
        </>
      )}
    </span>
  );
};

/** Attendees row (header + count summary + daily capacity note) */
const AttendeesSummaryRow = ({
  event,
  isDaily,
  dateFilter,
  dailySuffix,
  adjustedCount,
  completeQuantitySum,
}: {
  event: EventWithCount;
  isDaily: boolean;
  dateFilter: string | null;
  dailySuffix: string;
  adjustedCount: number;
  completeQuantitySum: number;
}): JSX.Element => (
  <tr>
    <th>Attendees{dailySuffix}</th>
    <td>
      <AttendeeCountDisplay
        adjustedCount={adjustedCount}
        completeQuantitySum={completeQuantitySum}
        dateFilter={dateFilter}
        event={event}
        isDaily={isDaily}
      />
      {isDaily && !dateFilter && (
        <>
          {" "}
          <small>Capacity of {event.max_attendees} applies per date</small>
        </>
      )}
    </td>
  </tr>
);

/** Event details table - all event metadata rows */
const EventDetailsTable = ({
  event,
  allowedDomain,
  ticketUrl,
  embedScriptCode,
  embedIframeCode,
  isDaily,
  dateFilter,
  dailySuffix,
  adjustedCount,
  completeQuantitySum,
  sharedRowsHtml,
}: {
  event: EventWithCount;
  allowedDomain: string;
  ticketUrl: string;
  embedScriptCode: string;
  embedIframeCode: string;
  isDaily: boolean;
  dateFilter: string | null;
  dailySuffix: string;
  adjustedCount: number;
  completeQuantitySum: number;
  sharedRowsHtml: string;
}): JSX.Element => (
  <article>
    <div class="table-scroll">
      <table class="event-details-table">
        <tbody>
          <tr>
            <th colspan="2">{event.name}</th>
          </tr>
          {event.date && (
            <tr>
              <th>Event Date</th>
              <td>
                <span>
                  <a href={`/admin/calendar?date=${event.date.slice(0, 10)}`}>
                    {formatDatetimeLabel(event.date)}
                  </a>{" "}
                  <small>
                    <em>({formatCountdown(event.date)})</em>
                  </small>
                </span>
              </td>
            </tr>
          )}
          {event.location && (
            <tr>
              <th>Location</th>
              <td>{event.location}</td>
            </tr>
          )}
          <tr>
            <th>Event Type</th>
            <td>{event.event_type === "daily" ? "Daily" : "Standard"}</td>
          </tr>
          {event.non_transferable && (
            <tr>
              <th>Non-Transferable</th>
              <td>Yes &mdash; ID verification required at entry</td>
            </tr>
          )}
          {event.hidden && (
            <tr>
              <th>Hidden</th>
              <td>Yes &mdash; not shown in public events list</td>
            </tr>
          )}
          {event.event_type === "daily" && <DailyScheduleRows event={event} />}
          <tr>
            <th>Registration Closes</th>
            <td>
              {event.closes_at ? (
                <span>
                  {formatDatetimeLabel(event.closes_at)}{" "}
                  <small>
                    <em>({formatCountdown(event.closes_at)})</em>
                  </small>
                </span>
              ) : (
                <em>No deadline</em>
              )}
            </td>
          </tr>
          <tr>
            <th>Public URL</th>
            <td>
              <a href={ticketUrl}>{`${allowedDomain}/ticket/${event.slug}`}</a>
              <small>
                {" "}
                (<a href={`/ticket/${event.slug}/qr`}>QR Code</a>)
              </small>
            </td>
          </tr>
          {event.thank_you_url && (
            <tr>
              <th>
                <label for={`thank-you-url-${event.id}`}>Thank You URL</label>
              </th>
              <td>
                <input
                  data-select-on-click
                  id={`thank-you-url-${event.id}`}
                  readonly
                  type="text"
                  value={event.thank_you_url}
                />
              </td>
            </tr>
          )}
          {event.webhook_url && (
            <tr>
              <th>
                <label for={`webhook-url-${event.id}`}>Webhook URL</label>
              </th>
              <td>
                <input
                  data-select-on-click
                  id={`webhook-url-${event.id}`}
                  readonly
                  type="text"
                  value={event.webhook_url}
                />
              </td>
            </tr>
          )}
          <tr>
            <th>
              <label for={`embed-script-${event.id}`}>Embed Script</label>
            </th>
            <td>
              <input
                data-select-on-click
                id={`embed-script-${event.id}`}
                readonly
                type="text"
                value={embedScriptCode}
              />
            </td>
          </tr>
          <tr>
            <th>
              <label for={`embed-iframe-${event.id}`}>Embed Iframe</label>
            </th>
            <td>
              <input
                data-select-on-click
                id={`embed-iframe-${event.id}`}
                readonly
                type="text"
                value={embedIframeCode}
              />
            </td>
          </tr>
          <AttendeesSummaryRow
            adjustedCount={adjustedCount}
            completeQuantitySum={completeQuantitySum}
            dailySuffix={dailySuffix}
            dateFilter={dateFilter}
            event={event}
            isDaily={isDaily}
          />
          <Raw html={sharedRowsHtml} />
        </tbody>
      </table>
    </div>
  </article>
);

/** Attendees filter links (All / Checked In / Checked Out) */
const AttendeesFilterLinks = ({
  basePath,
  dateQs,
  activeFilter,
}: {
  basePath: string;
  dateQs: string;
  activeFilter: AttendeeFilter;
}): JSX.Element => (
  <p>
    <Raw
      html={FilterLink({
        active: activeFilter === "all",
        href: `${basePath}${dateQs}#attendees`,
        label: "All",
      })}
    />
    {" / "}
    <Raw
      html={FilterLink({
        active: activeFilter === "in",
        href: `${basePath}/in${dateQs}#attendees`,
        label: "Checked In",
      })}
    />
    {" / "}
    <Raw
      html={FilterLink({
        active: activeFilter === "out",
        href: `${basePath}/out${dateQs}#attendees`,
        label: "Checked Out",
      })}
    />
  </p>
);

/** Attendees article section (header, optional check-in flash, filters, table) */
const AttendeesSection = ({
  allowedDomain,
  checkinMessage,
  isDaily,
  availableDates,
  activeFilter,
  dateFilter,
  basePath,
  dateQs,
  returnUrl,
  tableRows,
  questionData,
  phonePrefix,
}: {
  allowedDomain: string;
  checkinMessage: CheckinMessage | undefined;
  isDaily: boolean;
  availableDates: DateOption[];
  activeFilter: AttendeeFilter;
  dateFilter: string | null;
  basePath: string;
  dateQs: string;
  returnUrl: string;
  tableRows: AttendeeTableRow[];
  questionData: TableQuestionData | undefined;
  phonePrefix: string | undefined;
}): JSX.Element => {
  const checkedInLabel = checkinMessage?.status === "in" ? "in" : "out";
  const checkedInClass =
    checkinMessage?.status === "in"
      ? "checkin-message-in"
      : "checkin-message-out";
  return (
    <article>
      <h2 id="attendees">Attendees</h2>
      {checkinMessage && (
        <p class={checkedInClass} id="message">
          Checked {checkinMessage.name} {checkedInLabel}
        </p>
      )}
      {isDaily && availableDates.length > 0 && (
        <Raw
          html={DateSelector({
            activeFilter,
            basePath,
            dateFilter,
            dates: availableDates,
          })}
        />
      )}
      <AttendeesFilterLinks
        activeFilter={activeFilter}
        basePath={basePath}
        dateQs={dateQs}
      />
      <div class="table-scroll">
        <Raw
          html={AttendeeTable({
            activeFilter,
            allowedDomain,
            phonePrefix,
            questionData,
            returnUrl,
            rows: tableRows,
            showDate: isDaily,
            showEvent: false,
          })}
        />
      </div>
    </article>
  );
};

/** Failed payments article (only rendered when there are incomplete attendees) */
const FailedPaymentsSection = ({
  attendees,
  eventId,
}: {
  attendees: Attendee[];
  eventId: number;
}): JSX.Element => (
  <article>
    <h2 id="failed-payments">Failed Payments</h2>
    <p>{attendees.length} attendee(s) with unresolved payments</p>
    <div class="table-scroll">
      <Raw html={FailedPaymentsTable({ attendees, eventId })} />
    </div>
  </article>
);

/** Add attendee form article (only rendered in writable mode) */
const AddAttendeeSection = ({
  event,
}: {
  event: EventWithCount;
}): JSX.Element => (
  <article>
    <h2 id="add-attendee">Add Attendee</h2>
    <CsrfForm action={`/admin/event/${event.id}/attendee`}>
      <Raw
        html={renderFields(
          getAddAttendeeFields(event.fields, event.event_type === "daily"),
        )}
      />
      <button type="submit">Add Attendee</button>
    </CsrfForm>
  </article>
);

/** Compute derived attendee stats needed by the detail page */
const computeAttendeeStats = (
  event: EventWithCount,
  attendees: Attendee[],
  hasPaidEvent: boolean,
): {
  incompleteAttendees: Attendee[];
  completeAttendees: Attendee[];
  adjustedCount: number;
  completeQuantitySum: number;
} => {
  const incompleteAttendees = hasPaidEvent
    ? filter((a: Attendee) => isIncompletePayment(a, true))(attendees)
    : [];
  const completeAttendees = hasPaidEvent
    ? filter((a: Attendee) => !isIncompletePayment(a, true))(attendees)
    : attendees;
  const adjustedCount = event.attendee_count - sumQuantity(incompleteAttendees);
  const completeQuantitySum = sumQuantity(completeAttendees);
  return {
    adjustedCount,
    completeAttendees,
    completeQuantitySum,
    incompleteAttendees,
  };
};

export const adminEventPage = ({
  event,
  attendees,
  allowedDomain,
  session,
  checkinMessage,
  activeFilter = "all",
  dateFilter = null,
  availableDates = [],
  errorMessage,
  phonePrefix,
  successMessage,
  questionData,
}: AdminEventPageOptions): string => {
  const ticketUrl = `https://${allowedDomain}/ticket/${event.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } =
    buildEmbedSnippets(ticketUrl);
  const isDaily = event.event_type === "daily";
  const hasPaidEvent = isPaidEvent(event);

  const {
    incompleteAttendees,
    completeAttendees,
    adjustedCount,
    completeQuantitySum,
  } = computeAttendeeStats(event, attendees, hasPaidEvent);

  const filteredAttendees = filterAttendees(completeAttendees, activeFilter);
  const dailySuffix = isDaily
    ? dateFilter
      ? ` (${formatDateLabel(dateFilter)})`
      : " (total)"
    : "";
  const sharedRows = buildSharedDetailRows({
    attendeeCount: isDaily && dateFilter ? completeQuantitySum : adjustedCount,
    attendees: completeAttendees,
    hasPaidEvent,
    labelSuffix: dailySuffix,
    maxCapacity: isDaily && !dateFilter ? 0 : event.max_attendees,
    questionData,
    skipAttendees: true,
  });
  const basePath = `/admin/event/${event.id}`;
  const dateQs = dateFilter ? `?date=${dateFilter}` : "";
  const suffix = filterSuffix(activeFilter);
  const returnUrl = `${basePath}${suffix}${dateQs}#attendees`;
  const tableRows: AttendeeTableRow[] = pipe(
    map(
      (a: Attendee): AttendeeTableRow => ({
        attendee: a,
        eventId: event.id,
        eventName: event.name,
      }),
    ),
  )(filteredAttendees);

  return String(
    <Layout title={`Event: ${event.name}`}>
      <AdminNav active="/admin/" session={session} />
      <EventActionNav
        dateFilter={dateFilter}
        event={event}
        hasPaidEvent={hasPaidEvent}
      />
      <Flash success={successMessage} />
      {!event.active && (
        <div class="error" role="alert">
          This event is deactivated and cannot be booked
        </div>
      )}
      <Flash error={errorMessage} />
      <EventDetailsTable
        adjustedCount={adjustedCount}
        allowedDomain={allowedDomain}
        completeQuantitySum={completeQuantitySum}
        dailySuffix={dailySuffix}
        dateFilter={dateFilter}
        embedIframeCode={embedIframeCode}
        embedScriptCode={embedScriptCode}
        event={event}
        isDaily={isDaily}
        sharedRowsHtml={renderDetailRows(sharedRows)}
        ticketUrl={ticketUrl}
      />
      <AttendeesSection
        activeFilter={activeFilter}
        allowedDomain={allowedDomain}
        availableDates={availableDates}
        basePath={basePath}
        checkinMessage={checkinMessage}
        dateFilter={dateFilter}
        dateQs={dateQs}
        isDaily={isDaily}
        phonePrefix={phonePrefix}
        questionData={questionData}
        returnUrl={returnUrl}
        tableRows={tableRows}
      />
      {incompleteAttendees.length > 0 && (
        <FailedPaymentsSection
          attendees={incompleteAttendees}
          eventId={event.id}
        />
      )}
      {!isReadOnly() && <AddAttendeeSection event={event} />}
    </Layout>,
  );
};

/** Format an ISO datetime string for datetime-local input (YYYY-MM-DDTHH:MM) */
const formatDatetimeLocal = (iso: string | null): string | null => {
  if (!iso) return null;
  return utcToLocalInput(iso, settings.timezone);
};

/** Convert bookable_days array to comma-separated display string */
const formatBookableDays = (days: string[]): string => days.join(",");

const eventToFieldValues = (event: EventWithCount): FieldValues => ({
  assign_built_site: event.assign_built_site ? "1" : "",
  bookable_days: formatBookableDays(event.bookable_days),
  can_pay_more: event.can_pay_more ? "1" : "",
  closes_at: formatDatetimeLocal(event.closes_at),
  date: event.date ? formatDatetimeLocal(event.date) : null,
  description: event.description,
  event_type: event.event_type,
  fields: event.fields,
  group_id: event.group_id,
  hidden: event.hidden ? "1" : "",
  location: event.location,
  max_attendees: event.max_attendees,
  max_price: toMajorUnits(event.max_price),
  max_quantity: event.max_quantity,
  maximum_days_after: event.maximum_days_after,
  minimum_days_before: event.minimum_days_before,
  name: event.name,
  non_transferable: event.non_transferable ? "1" : "",
  slug: event.slug,
  thank_you_url: event.thank_you_url,
  unit_price: event.unit_price > 0 ? toMajorUnits(event.unit_price) : "",
  webhook_url: event.webhook_url,
});

/** Event fields with autofocus on the name field */
const eventFieldsWithAutofocus: Field[] = pipe(
  map((f: Field): Field => (f.name === "name" ? { ...f, autofocus: true } : f)),
)(eventFields);

/**
 * Admin event create page
 */
export const adminEventNewPage = (
  groups: Group[],
  session: AdminSession,
  error?: string,
): string => {
  const storageEnabled = isStorageEnabled();
  const builderEnabled = isBuilderEnabled();
  const fields = [
    ...eventFields,
    ...(builderEnabled ? [assignBuiltSiteField] : []),
    ...(storageEnabled ? [imageField, attachmentField] : []),
  ];
  return String(
    <Layout title="Add Event">
      <AdminNav active="/admin/" session={session} />

      <CsrfForm action="/admin/event" enctype="multipart/form-data">
        <h1>Add Event</h1>
        <Flash error={error} />
        <Raw html={renderFields(fields)} />
        <EventGroupSelect groups={groups} selectedGroupId={0} />
        <button type="submit">Create Event</button>
      </CsrfForm>
    </Layout>,
  );
};

/**
 * Admin duplicate event page - create form pre-filled with existing event settings
 */
export const adminDuplicateEventPage = (
  event: EventWithCount,
  groups: Group[],
  session: AdminSession,
): string => {
  const values = eventToFieldValues(event);
  values.name = "";
  const builderEnabled = isBuilderEnabled();
  const storageEnabled = isStorageEnabled();
  const dupFields = [
    ...eventFieldsWithAutofocus,
    ...(builderEnabled ? [assignBuiltSiteField] : []),
    ...(storageEnabled ? [imageField, attachmentField] : []),
  ];

  return String(
    <Layout title={`Duplicate: ${event.name}`}>
      <AdminNav active="/admin/" session={session} />
      <h2>Duplicate Event</h2>
      <p>
        Creating a new event based on <strong>{event.name}</strong>.
      </p>
      <CsrfForm action="/admin/event" enctype="multipart/form-data">
        <Raw html={renderFields(dupFields, values)} />
        <EventGroupSelect groups={groups} selectedGroupId={event.group_id} />
        <button type="submit">Create Event</button>
      </CsrfForm>
    </Layout>,
  );
};

/**
 * Admin event edit page
 */
export const adminEventEditPage = (
  event: EventWithCount,
  groups: Group[],
  session: AdminSession,
  error?: string,
): string => {
  const storageEnabled = isStorageEnabled();
  const builderEnabled = isBuilderEnabled();
  const fields = [
    ...eventFields,
    ...(builderEnabled ? [assignBuiltSiteField] : []),
    ...(storageEnabled ? [imageField, attachmentField] : []),
  ];
  return String(
    <Layout title={`Edit: ${event.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />
      <CsrfForm
        action={`/admin/event/${event.id}/edit`}
        enctype="multipart/form-data"
      >
        <Raw html={renderFields(fields, eventToFieldValues(event))} />
        <EventGroupSelect groups={groups} selectedGroupId={event.group_id} />
        <Raw html={renderField(slugField, String(event.slug))} />
        {storageEnabled && event.image_url && (
          <Raw html={renderEventImage(event, "event-image-full")} />
        )}
        <button type="submit">Save Changes</button>
      </CsrfForm>
      {storageEnabled && event.image_url && (
        <CsrfForm action={`/admin/event/${event.id}/image/delete`}>
          <button class="secondary" type="submit">
            Remove Image
          </button>
        </CsrfForm>
      )}
      {storageEnabled && event.attachment_name && (
        <div class="attachment-info">
          <p>
            Current attachment: <strong>{event.attachment_name}</strong>
          </p>
          <CsrfForm action={`/admin/event/${event.id}/attachment/delete`}>
            <button class="secondary" type="submit">
              Remove Attachment
            </button>
          </CsrfForm>
        </div>
      )}
    </Layout>,
  );
};

/**
 * Admin delete event confirmation page
 */
export const adminDeleteEventPage = (
  event: EventWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Delete: ${event.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/event/${event.id}/delete`}
        buttonText="Delete Event"
        label="Event name"
        name={event.name}
      >
        <p>
          <strong>Warning:</strong> This will permanently delete the event, all{" "}
          {event.attendee_count} attendee(s), any associated payment records,
          and all activity log entries for this event.
        </p>
        <p>
          To delete this event, type its name "{event.name}" into the box below:
        </p>
      </ConfirmForm>
    </Layout>,
  );

/**
 * Admin deactivate event confirmation page
 */
export const adminDeactivateEventPage = (
  event: EventWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Deactivate: ${event.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/event/${event.id}/deactivate`}
        buttonText="Deactivate Event"
        label="Event name"
        name={event.name}
      >
        <p>
          <strong>Warning:</strong> Deactivating this event will:
        </p>
        <ul>
          <li>Return a 404 error on the public ticket page</li>
          <li>Prevent new registrations</li>
          <li>Reject any pending payments</li>
        </ul>
        <p>Existing attendees will not be affected.</p>
        <p>
          To deactivate this event, type its name "{event.name}" into the box
          below:
        </p>
      </ConfirmForm>
    </Layout>,
  );

/**
 * Admin reactivate event confirmation page
 */
export const adminReactivateEventPage = (
  event: EventWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Reactivate: ${event.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/event/${event.id}/reactivate`}
        buttonText="Reactivate Event"
        danger={false}
        label="Event name"
        name={event.name}
      >
        <p>
          Reactivating this event will make it available for registrations
          again.
        </p>
        <p>
          The public ticket page will be accessible and new attendees can
          register.
        </p>
        <p>
          To reactivate this event, type its name "{event.name}" into the box
          below:
        </p>
      </ConfirmForm>
    </Layout>,
  );
