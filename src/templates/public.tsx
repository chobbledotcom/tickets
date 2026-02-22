/**
 * Public page templates - ticket reservation pages
 */

import { map, pipe } from "#fp";
import { formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
import type { Field } from "#lib/forms.tsx";
import { CsrfForm, renderError, renderFields } from "#lib/forms.tsx";
import { getImageProxyUrl } from "#lib/storage.ts";
import type { EventFields, EventWithCount } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { getTicketFields, mergeEventFields } from "#templates/fields.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Public site navigation */
const PublicNav = (): JSX.Element => (
  <nav>
    <ul>
      <li><a href="/">Home</a></li>
      <li><a href="/events">Events</a></li>
      <li><a href="/terms">T&amp;Cs</a></li>
      <li><a href="/contact">Contact</a></li>
    </ul>
  </nav>
);

/** Public site page type */
export type PublicPageType = "home" | "terms" | "contact";

/** Render a plain-text content block with line breaks preserved */
const renderPlainText = (text: string): string =>
  escapeHtml(text).replace(/\r\n|\r|\n/g, "<br>");

/**
 * Public site page - basic page with nav and content
 */
export const publicSitePage = (
  pageType: PublicPageType,
  websiteTitle?: string | null,
  content?: string | null,
): string => {
  const titles: Record<PublicPageType, string> = {
    home: "Home",
    terms: "Terms & Conditions",
    contact: "Contact",
  };
  const pageTitle = websiteTitle ? `${titles[pageType]} - ${websiteTitle}` : titles[pageType];

  return String(
    <Layout title={pageTitle}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav />
      {content ? (
        <p><Raw html={renderPlainText(content)} /></p>
      ) : (
        <p><em>No content.</em></p>
      )}
      <footer class="homepage-footer">
        <p><a href="/admin/login">Login</a></p>
      </footer>
    </Layout>
  );
};

/** Render a single event listing for the events page */
const renderEventListing = (info: MultiTicketEvent): string => {
  const { event, isSoldOut, isClosed } = info;
  const details: string[] = [];
  if (event.location) details.push(`<li><strong>${escapeHtml(event.location)}</strong></li>`);
  if (event.date) details.push(`<li><em>${escapeHtml(formatDatetimeLabel(event.date))}</em></li>`);
  const detailsHtml = details.length > 0 ? `<ul>${details.join("")}</ul>` : "";
  const descriptionHtml = event.description
    ? `<p>${escapeHtml(event.description)}</p>`
    : "";
  const linkHtml = isSoldOut
    ? `<p><strong>Sold Out</strong></p>`
    : isClosed
      ? `<p><strong>Registration Closed</strong></p>`
      : `<p><a href="/ticket/${escapeHtml(event.slug)}"><strong>Book now</strong></a></p>`;

  return `<h2>${escapeHtml(event.name)}</h2>${detailsHtml}${descriptionHtml}${linkHtml}`;
};

/**
 * Homepage with events - lists all active upcoming events with booking links
 */
export const homepagePage = (
  events: MultiTicketEvent[],
  websiteTitle?: string | null,
): string => {
  const title = websiteTitle ? `Events - ${websiteTitle}` : "Events";

  if (events.length === 0) {
    return String(
      <Layout title={title}>
        {websiteTitle && <h1>{websiteTitle}</h1>}
        <PublicNav />
        <p><em>No events listed.</em></p>
        <footer class="homepage-footer">
          <p><a href="/admin/login">Login</a></p>
        </footer>
      </Layout>
    );
  }

  const eventListings = pipe(
    map(renderEventListing),
    (rows: string[]) => rows.join(""),
  )(events);

  return String(
    <Layout title={title}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav />
      <h2>All bookable events</h2>
      <Raw html={eventListings} />
      <footer class="homepage-footer">
        <p><a href="/admin/login">Login</a></p>
      </footer>
    </Layout>
  );
};

/** Render event image HTML if image_url is set */
export const renderEventImage = (event: { image_url: string; name: string }, className = "event-image"): string =>
  event.image_url
    ? `<img src="${escapeHtml(getImageProxyUrl(event.image_url))}" alt="${escapeHtml(event.name)}" class="${className}" />`
    : "";

/** Build OpenGraph meta tags for a public event page */
export const buildOgTags = (
  event: { name: string; description: string; slug: string; image_url: string },
  baseUrl: string,
): string => {
  const tags = [
    `<meta property="og:title" content="${escapeHtml(event.name)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escapeHtml(baseUrl)}/ticket/${escapeHtml(event.slug)}">`,
  ];
  if (event.description) {
    tags.push(`<meta property="og:description" content="${escapeHtml(event.description)}">`);
  }
  if (event.image_url) {
    tags.push(`<meta property="og:image" content="${escapeHtml(baseUrl)}${escapeHtml(getImageProxyUrl(event.image_url))}">`);
  }
  return tags.join("\n");
};

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
  `<div class="terms"><p>${escapeHtml(terms).replace(/\r\n|\r|\n/g, "<br>")}</p></div>` +
  `<label><input type="checkbox" name="agree_terms" value="1" required> I agree to the terms and conditions above</label>`;

/**
 * Public ticket page
 */
export const ticketPage = (
  event: EventWithCount,
  error: string | undefined,
  isClosed: boolean,
  inIframe: boolean,
  availableDates: string[] | undefined,
  termsAndConditions: string | null | undefined,
  baseUrl?: string,
): string => {
  const spotsRemaining = event.max_attendees - event.attendee_count;
  const isFull = spotsRemaining <= 0;
  const maxPurchasable = Math.min(event.max_quantity, spotsRemaining);
  const showQuantity = maxPurchasable > 1;
  const fields: Field[] = getTicketFields(event.fields);
  const isDaily = event.event_type === "daily";
  const headExtra = baseUrl ? buildOgTags(event, baseUrl) : undefined;

  return String(
    <Layout title={event.name} bodyClass={inIframe ? "iframe" : undefined} headExtra={headExtra}>
      {!inIframe && (
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
          <CsrfForm action={`/ticket/${event.slug}${inIframe ? "?iframe=true" : ""}`}>
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
          </CsrfForm>
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

/**
 * Temporary error page with auto-refresh
 * Used when a transient CDN or network error occurs
 */
export const temporaryErrorPage = (): string =>
  String(
    <Layout title="Temporary Error" headExtra='<meta http-equiv="refresh" content="2" />'>
      <h1>Temporary Error</h1>
      <p>Something went wrong loading this page. Retrying automatically&hellip;</p>
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
  error?: string,
  availableDates?: string[],
  termsAndConditions?: string | null,
  inIframe = false,
): string => {
  const allUnavailable = events.every((e) => e.isSoldOut || e.isClosed);
  const allClosed = events.every((e) => e.isClosed);
  const formAction = `/ticket/${slugs.join("+")}${inIframe ? "?iframe=true" : ""}`;
  const fieldsSetting = getMultiTicketFieldsSetting(events);
  const fields: Field[] = getTicketFields(fieldsSetting);
  const hasDaily = events.some((e) => e.event.event_type === "daily");

  const eventRows = pipe(
    map(renderMultiEventRow),
    (rows: string[]) => rows.join(""),
  )(events);

  return String(
    <Layout title="Reserve Tickets" bodyClass={inIframe ? "iframe" : undefined}>
      <Raw html={renderError(error)} />

      {allUnavailable ? (
        <div class="error">{allClosed ? "Registration closed." : "Sorry, all events are sold out."}</div>
      ) : (
        <CsrfForm action={formAction}>
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
        </CsrfForm>
      )}
    </Layout>
  );
};
