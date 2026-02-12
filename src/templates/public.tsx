/**
 * Public page templates - ticket reservation pages
 */

import { map, pipe } from "#fp";
import { formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
import type { Field } from "#lib/forms.tsx";
import { renderError, renderFields } from "#lib/forms.tsx";
import { getImageProxyUrl } from "#lib/storage.ts";
import type { EventFields, EventWithCount } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { getTicketFields, mergeEventFields } from "#templates/fields.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Render event image HTML if image_url is set */
export const renderEventImage = (event: { image_url: string | null; name: string }): string =>
  event.image_url
    ? `<img src="${escapeHtml(getImageProxyUrl(event.image_url))}" alt="${escapeHtml(event.name)}" style="max-width: 100%; border-radius: 4px; margin-bottom: 1rem;" />`
    : "";

/** Render a date selector dropdown for daily events */
const renderDateSelector = (dates: string[]): string =>
  dates.length === 0
    ? `<div class="error">No dates are currently available for booking.</div>`
    : `<label for="date">Select Date</label>
       <select name="date" id="date" required>
         <option value="">— Select a date —</option>
         ${dates.map((d) => `<option value="${d}">${formatDateLabel(d)}</option>`).join("")}
       </select>`;

/** Quantity values parsed from multi-ticket form */
export type MultiTicketQuantities = Map<number, number>;

/**
 * Build quantity select options
 */
const quantityOptions = (max: number): string =>
  Array.from({ length: max }, (_, i) => i + 1)
    .map((n) => `<option value="${n}">${n}</option>`)
    .join("");

/** Render terms and conditions block with agreement checkbox */
const renderTermsAndCheckbox = (terms: string): string =>
  `<div class="terms"><p>${escapeHtml(terms)}</p></div>` +
  `<label><input type="checkbox" name="agree_terms" value="1" required> I agree to the terms and conditions above</label>`;

/**
 * Public ticket page
 */
export const ticketPage = (
  event: EventWithCount,
  csrfToken: string,
  error?: string,
  isClosed = false,
  iframe = false,
  availableDates?: string[],
  termsAndConditions?: string | null,
): string => {
  const spotsRemaining = event.max_attendees - event.attendee_count;
  const isFull = spotsRemaining <= 0;
  const maxPurchasable = Math.min(event.max_quantity, spotsRemaining);
  const showQuantity = maxPurchasable > 1;
  const fields: Field[] = getTicketFields(event.fields);
  const isDaily = event.event_type === "daily";

  return String(
    <Layout title={event.name} bodyClass={iframe ? "iframe" : undefined}>
      {!iframe && (
        <>
          <Raw html={renderEventImage(event)} />
          <h1>{event.name}</h1>
          {event.description && (
            <div class="description">
              <Raw html={escapeHtml(event.description)} />
            </div>
          )}
          {event.date && (
            <p><strong>Date:</strong> {formatDatetimeLabel(event.date)}</p>
          )}
          {event.location && (
            <p><strong>Location:</strong> {event.location}</p>
          )}
        </>
      )}
      <Raw html={renderError(error)} />

      {isClosed ? (
          <div class="error">Registration closed.</div>
      ) : isFull ? (
          <div class="error">Sorry, this event is full.</div>
      ) : (
          <form method="POST" action={`/ticket/${event.slug}`}>
            <input type="hidden" name="csrf_token" value={csrfToken} />
            <Raw html={renderFields(fields)} />
            {isDaily && availableDates && (
              <Raw html={renderDateSelector(availableDates)} />
            )}
            {showQuantity ? (
              <>
                <label for="quantity">Number of Tickets</label>
                <select name="quantity" id="quantity">
                  <Raw html={quantityOptions(maxPurchasable)} />
                </select>
              </>
            ) : (
              <input type="hidden" name="quantity" value="1" />
            )}
            {termsAndConditions && (
              <Raw html={renderTermsAndCheckbox(termsAndConditions)} />
            )}
            <button type="submit">Reserve Ticket{showQuantity ? "s" : ""}</button>
          </form>
      )}
    </Layout>
  );
};

/**
 * Not found page
 */
export const notFoundPage = (): string =>
  String(
    <Layout title="Not Found">
      <h1>Not Found</h1>
    </Layout>
  );

/** Event info for multi-ticket display */
export type MultiTicketEvent = {
  event: EventWithCount;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
};

/** Build multi-ticket event info from event */
export const buildMultiTicketEvent = (
  event: EventWithCount,
  closed = false,
): MultiTicketEvent => {
  const spotsRemaining = event.max_attendees - event.attendee_count;
  const isSoldOut = spotsRemaining <= 0;
  const maxPurchasable = isSoldOut || closed
    ? 0
    : Math.min(event.max_quantity, spotsRemaining);
  return { event, isSoldOut, isClosed: closed, maxPurchasable };
};

/** Render description HTML for multi-ticket event row */
const renderMultiEventDescription = (description: string): string =>
  description
    ? `<div class="description-compact">${escapeHtml(description)}</div>`
    : "";

/** Render quantity selector for a single event in multi-ticket form */
const renderMultiEventRow = (info: MultiTicketEvent): string => {
  const { event, isSoldOut, isClosed, maxPurchasable } = info;
  const fieldName = `quantity_${event.id}`;
  const imageHtml = renderEventImage(event);

  if (isClosed) {
    return `
      <div class="multi-ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(event.name)}</label>
        <span class="sold-out-label">Registration Closed</span>
      </div>
    `;
  }

  if (isSoldOut) {
    return `
      <div class="multi-ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(event.name)}</label>
        ${renderMultiEventDescription(event.description)}
        <span class="sold-out-label">Sold Out</span>
      </div>
    `;
  }

  const options = Array.from({ length: maxPurchasable + 1 }, (_, i) => i)
    .map((n) => `<option value="${n}">${n}</option>`)
    .join("");

  return `
    <div class="multi-ticket-row">
      ${imageHtml}
      <label for="${fieldName}">${escapeHtml(event.name)}</label>
      ${renderMultiEventDescription(event.description)}
      <select name="${fieldName}" id="${fieldName}">
        ${options}
      </select>
    </div>
  `;
};

/**
 * Determine the merged fields setting for a set of multi-ticket events
 */
const getMultiTicketFieldsSetting = (events: MultiTicketEvent[]): EventFields =>
  mergeEventFields(events.map((e) => e.event.fields));

/**
 * Multi-ticket page - register for multiple events at once
 */
export const multiTicketPage = (
  events: MultiTicketEvent[],
  slugs: string[],
  csrfToken: string,
  error?: string,
  availableDates?: string[],
  termsAndConditions?: string | null,
): string => {
  const allUnavailable = events.every((e) => e.isSoldOut || e.isClosed);
  const allClosed = events.every((e) => e.isClosed);
  const formAction = `/ticket/${slugs.join("+")}`;
  const fieldsSetting = getMultiTicketFieldsSetting(events);
  const fields: Field[] = getTicketFields(fieldsSetting);
  const hasDaily = events.some((e) => e.event.event_type === "daily");

  const eventRows = pipe(
    map(renderMultiEventRow),
    (rows: string[]) => rows.join(""),
  )(events);

  return String(
    <Layout title="Reserve Tickets">
      <Raw html={renderError(error)} />

      {allUnavailable ? (
        <div class="error">{allClosed ? "Registration closed." : "Sorry, all events are sold out."}</div>
      ) : (
        <form method="POST" action={formAction}>
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <Raw html={renderFields(fields)} />
          {hasDaily && availableDates && (
            <Raw html={renderDateSelector(availableDates)} />
          )}

          <fieldset class="multi-ticket-events">
            <legend>Select Tickets</legend>
            <Raw html={eventRows} />
          </fieldset>

          {termsAndConditions && (
            <Raw html={renderTermsAndCheckbox(termsAndConditions)} />
          )}
          <button type="submit">Reserve Tickets</button>
        </form>
      )}
    </Layout>
  );
};
