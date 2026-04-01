/**
 * Public page templates - ticket reservation pages
 */

import { map, pipe } from "#fp";
import { formatCurrency, toMajorUnits } from "#lib/currency.ts";
import { daysAgo, formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
import type {
  QuestionEventMap,
  QuestionWithAnswers,
} from "#lib/db/questions.ts";
import { settings } from "#lib/db/settings.ts";
import { isReadOnly } from "#lib/env.ts";
import type { Field } from "#lib/forms.tsx";
import { CsrfForm, renderError, renderFields } from "#lib/forms.tsx";
import { getIframeMode } from "#lib/iframe.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { renderMarkdown, renderMarkdownInline } from "#lib/markdown.ts";
import { getImageProxyUrl } from "#lib/storage.ts";
import {
  type EventFields,
  type EventWithCount,
  isPaidEvent,
} from "#lib/types.ts";
import { getTicketFields, mergeEventFields } from "#templates/fields.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Public site navigation - hides terms/contact links when those pages are empty */
const PublicNav = ({
  hasTerms,
  hasContact,
}: {
  hasTerms?: boolean;
  hasContact?: boolean;
}): JSX.Element => (
  <nav>
    <ul>
      <li>
        <a href="/">Home</a>
      </li>
      <li>
        <a href="/events">Events</a>
      </li>
      {hasTerms && (
        <li>
          <a href="/terms">T&amp;Cs</a>
        </li>
      )}
      {hasContact && (
        <li>
          <a href="/contact">Contact</a>
        </li>
      )}
    </ul>
  </nav>
);

/** Compute which public pages have content */
const navFlags = () => ({
  hasTerms: !!settings.terms,
  hasContact: !!settings.contactPageText,
});

/** Public site page type */
export type PublicPageType = "home" | "terms" | "contact";

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
  const pageTitle = websiteTitle
    ? `${titles[pageType]} - ${websiteTitle}`
    : titles[pageType];

  return String(
    <Layout title={pageTitle} headExtra={FEED_DISCOVERY_TAGS}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...navFlags()} />
      <div class="prose">
        {content ? (
          <Raw html={renderMarkdown(content)} />
        ) : (
          <p>
            <em>No content.</em>
          </p>
        )}
      </div>
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">Login</a>
        </p>
      </footer>
    </Layout>,
  );
};

/** Render a single event listing for the events page */
const renderEventListing = (info: TicketEvent): string => {
  const { event, isSoldOut, isClosed } = info;
  const details: string[] = [];
  if (event.location)
    details.push(`<li><strong>${escapeHtml(event.location)}</strong></li>`);
  if (event.date)
    details.push(
      `<li><em>${escapeHtml(formatDatetimeLabel(event.date))}</em></li>`,
    );
  const detailsHtml = details.length > 0 ? `<ul>${details.join("")}</ul>` : "";
  const descriptionHtml = event.description
    ? `<p>${renderMarkdownInline(event.description)}</p>`
    : "";
  const linkHtml = isSoldOut
    ? "<p><strong>Sold Out</strong></p>"
    : isClosed || isReadOnly()
      ? "<p><strong>Registration Closed</strong></p>"
      : `<p><a href="/ticket/${escapeHtml(event.slug)}"><strong>Book now</strong></a></p>`;

  return `<div class="prose"><h2>${escapeHtml(event.name)}</h2>${descriptionHtml}</div>${detailsHtml}${linkHtml}`;
};

/**
 * Homepage with events - lists all active upcoming events with booking links
 */
export const RSS_DISCOVERY_TAG =
  '<link rel="alternate" type="application/rss+xml" title="Events" href="/feeds/events.rss" />';

export const ICS_DISCOVERY_TAG =
  '<link rel="alternate" type="text/calendar" title="Events" href="/feeds/events.ics" />';

export const FEED_DISCOVERY_TAGS = `${RSS_DISCOVERY_TAG}\n${ICS_DISCOVERY_TAG}`;

export const homepagePage = (
  events: TicketEvent[],
  websiteTitle?: string | null,
): string => {
  const title = websiteTitle ? `Events - ${websiteTitle}` : "Events";

  if (events.length === 0) {
    return String(
      <Layout title={title} headExtra={FEED_DISCOVERY_TAGS}>
        {websiteTitle && <h1>{websiteTitle}</h1>}
        <PublicNav {...navFlags()} />
        <p>
          <em>No events listed.</em>
        </p>
        <footer class="homepage-footer">
          <p>
            <a href="/admin/login">Login</a>
          </p>
        </footer>
      </Layout>,
    );
  }

  const eventListings = pipe(map(renderEventListing), (rows: string[]) =>
    rows.join(""),
  )(events);

  return String(
    <Layout title={title} headExtra={FEED_DISCOVERY_TAGS}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...navFlags()} />
      <h2>All bookable events</h2>
      <Raw html={eventListings} />
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">Login</a>
        </p>
      </footer>
    </Layout>,
  );
};

/** Render event image HTML if image_url is set */
export const renderEventImage = (
  event: { image_url: string; name: string },
  className = "event-image",
): string =>
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
    tags.push(
      `<meta property="og:description" content="${escapeHtml(event.description)}">`,
    );
  }
  if (event.image_url) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(baseUrl)}${escapeHtml(getImageProxyUrl(event.image_url))}">`,
    );
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

/** Quantity values parsed from ticket form */
export type TicketQuantities = Map<number, number>;

/** Render a price input for pay-more events */
const renderPayMoreInput = (
  event: Pick<EventWithCount, "unit_price" | "max_price">,
  fieldName = "custom_price",
): string => {
  const minPrice = event.unit_price;
  const maxPrice = event.max_price;
  const rangeHint =
    minPrice > 0
      ? `Your Price (${formatCurrency(minPrice)} minimum)`
      : `Your Price (optional, up to ${formatCurrency(maxPrice)})`;
  return (
    `<label>${rangeHint}` +
    `<input type="text" inputmode="decimal" name="${fieldName}" value="${escapeHtml(toMajorUnits(minPrice))}" min="${escapeHtml(toMajorUnits(minPrice))}" max="${escapeHtml(toMajorUnits(maxPrice))}" pattern="\\d+(\\.\\d{1,2})?" title="A non-negative number (e.g. 10.00)"${minPrice > 0 ? " required" : ""} /></label>`
  );
};

/** Render terms and conditions block with agreement checkbox */
const renderTermsAndCheckbox = (terms: string): string =>
  `<div class="prose">${renderMarkdown(terms)}</div>` +
  `<label class="terms-agree"><input type="checkbox" name="agree_terms" value="1" required> I agree to the terms above</label>`;

/** Render custom multiple-choice question fields (radio buttons).
 * When questionEventMap is provided, adds data-event-ids
 * so JS can show/hide questions based on selected event quantities. */
export const renderQuestions = (
  questions: QuestionWithAnswers[],
  questionEventMap?: QuestionEventMap,
): string => {
  if (questions.length === 0) return "";
  return questions
    .map((q) => {
      const options = q.answers
        .map(
          (a) =>
            `<label><input type="radio" name="question_${q.id}" value="${a.id}" required> ${escapeHtml(a.text)}</label>`,
        )
        .join("");
      const eventIds = questionEventMap?.get(q.id);
      const eventAttr = eventIds
        ? ` data-event-ids="${eventIds.join(" ")}"`
        : "";
      return `<fieldset class="custom-question"${eventAttr}><legend>${escapeHtml(q.text)}</legend>${options}</fieldset>`;
    })
    .join("");
};

/**
 * Not found page
 */
export const notFoundPage = (): string =>
  String(
    <Layout title="Not Found">
      <h1>Not Found</h1>
    </Layout>,
  );

/**
 * Temporary error page with auto-refresh
 * Used when a transient CDN or network error occurs
 */
export const temporaryErrorPage = (): string =>
  String(
    <Layout
      title="Temporary Error"
      headExtra='<meta http-equiv="refresh" content="2" />'
    >
      <h1>Temporary Error</h1>
      <p>
        Something went wrong loading this page. Retrying automatically&hellip;
      </p>
    </Layout>,
  );

/**
 * Read-only mode page
 */
export const readOnlyPage = (): string =>
  String(
    <Layout title="Read Only">
      <p>Disabled: This site is in read-only mode.</p>
    </Layout>,
  );

/** Event info for ticket display */
export type TicketEvent = {
  event: EventWithCount;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
};

/** Build ticket event info from event */
export const buildTicketEvent = (
  event: EventWithCount,
  closed = false,
): TicketEvent => {
  const spotsRemaining = event.max_attendees - event.attendee_count;
  const isSoldOut = spotsRemaining <= 0;
  const maxPurchasable =
    isSoldOut || closed ? 0 : Math.min(event.max_quantity, spotsRemaining);
  return { event, isSoldOut, isClosed: closed, maxPurchasable };
};

/** Render description HTML for event row */
const renderEventDescription = (description: string): string =>
  description
    ? `<div class="description-compact">${renderMarkdownInline(description)}</div>`
    : "";

/** Render quantity selector for an event row */
const renderEventRow = (info: TicketEvent, hideQuantity = false): string => {
  const { event, isSoldOut, isClosed, maxPurchasable } = info;
  const fieldName = `quantity_${event.id}`;
  const imageHtml = renderEventImage(event);

  if (isClosed) {
    return `
      <div class="ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(event.name)}</label>
        <span class="sold-out-label">Registration Closed</span>
      </div>
    `;
  }

  if (isSoldOut) {
    return `
      <div class="ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(event.name)}</label>
        ${renderEventDescription(event.description)}
        <span class="sold-out-label">Sold Out</span>
      </div>
    `;
  }

  const quantityHtml = hideQuantity
    ? `<input type="hidden" name="${fieldName}" value="1" />`
    : (() => {
        const options = Array.from({ length: maxPurchasable + 1 }, (_, i) => i)
          .map((n) => `<option value="${n}">${n}</option>`)
          .join("");
        return `<select name="${fieldName}">${options}</select>`;
      })();

  const showPayMore = event.can_pay_more;
  const priceFieldName = `custom_price_${event.id}`;

  return `
    <div class="ticket-row">
      ${imageHtml}
      <label>${escapeHtml(event.name)}${quantityHtml}</label>
      ${renderEventDescription(event.description)}
      ${showPayMore ? renderPayMoreInput(event, priceFieldName) : ""}
    </div>
  `;
};

/** Render controls for a single event: quantity input + pay-more (no event name/image/description). */
const renderSingleEventControls = (
  info: TicketEvent,
  hideQuantity: boolean,
): string => {
  const { event, maxPurchasable } = info;
  const fieldName = `quantity_${event.id}`;
  const quantityHtml = hideQuantity
    ? `<input type="hidden" name="${fieldName}" value="1" />`
    : (() => {
        const options = Array.from({ length: maxPurchasable + 1 }, (_, i) => i)
          .map((n) => `<option value="${n}">${n}</option>`)
          .join("");
        return `<label>Number of Tickets<select name="${fieldName}">${options}</select></label>`;
      })();
  const showPayMore = event.can_pay_more;
  const priceFieldName = `custom_price_${event.id}`;
  return `${quantityHtml}${showPayMore ? renderPayMoreInput(event, priceFieldName) : ""}`;
};

/**
 * Determine the merged fields setting for the selected events
 */
const getTicketFieldsSetting = (events: TicketEvent[]): EventFields =>
  mergeEventFields(events.map((e) => e.event.fields));

/** Options for the ticket page */
export type TicketPageOptions = {
  events: TicketEvent[];
  slugs: string[];
  error?: string;
  dates?: string[];
  terms?: string | null;
  questions?: QuestionWithAnswers[];
  questionEventMap?: QuestionEventMap;
  baseUrl?: string;
};

/**
 * Ticket page - register for one or more events
 * Single events show rich details (image, description, date, location).
 * Multiple events show a compact row layout with per-event quantity selectors.
 */
export const ticketPage = ({
  events,
  slugs,
  error,
  dates,
  terms,
  questions,
  questionEventMap,
  baseUrl,
}: TicketPageOptions): string => {
  const inIframe = getIframeMode();
  const allUnavailable = events.every((e) => e.isSoldOut || e.isClosed);
  const allClosed = events.every((e) => e.isClosed);
  const fieldsSetting = getTicketFieldsSetting(events);
  const anyPaid = events.some((e) => isPaidEvent(e.event));
  const fields: Field[] = getTicketFields(fieldsSetting, anyPaid);
  const hasDaily = events.some((e) => e.event.event_type === "daily");

  const isSingleEvent = events.length === 1;
  const singleEvent = isSingleEvent ? events[0]!.event : null;
  const pastDays = singleEvent?.date ? daysAgo(singleEvent.date) : null;

  const availableEvents = events.filter((e) => !e.isSoldOut && !e.isClosed);
  const hideQuantity =
    availableEvents.length === 1 && availableEvents[0]?.maxPurchasable === 1;

  // For single events, render just the quantity/pay-more controls (event details are in the header).
  // For multiple events, render full event rows with name, image, and description.
  const eventRows = isSingleEvent
    ? renderSingleEventControls(events[0]!, hideQuantity)
    : events.map((e) => renderEventRow(e, hideQuantity)).join("");

  const title = singleEvent ? singleEvent.name : "Reserve Tickets";
  const headExtra =
    singleEvent && baseUrl ? buildOgTags(singleEvent, baseUrl) : undefined;
  const buttonText =
    isSingleEvent && hideQuantity ? "Reserve Ticket" : "Reserve Tickets";

  return String(
    <Layout
      title={title}
      bodyClass={inIframe ? "iframe" : undefined}
      headExtra={headExtra}
    >
      {singleEvent && !inIframe && (
        <>
          <Raw html={renderEventImage(singleEvent)} />
          <div class="prose">
            <h1>{singleEvent.name}</h1>
            {singleEvent.description && (
              <div class="description">
                <Raw html={renderMarkdownInline(singleEvent.description)} />
              </div>
            )}
            {singleEvent.date && (
              <p>
                <strong>Date:</strong> {formatDatetimeLabel(singleEvent.date)}
                {pastDays !== null && (
                  <span class="badge-alert">
                    {" "}
                    {pastDays} {pastDays === 1 ? "day" : "days"} ago
                  </span>
                )}
              </p>
            )}
            {singleEvent.location && (
              <p>
                <strong>Location:</strong> {singleEvent.location}
              </p>
            )}
          </div>
        </>
      )}
      <Raw html={renderError(error)} />

      {allUnavailable || isReadOnly() ? (
        <div class="error">
          {isReadOnly()
            ? "Registration closed."
            : isSingleEvent
              ? allClosed
                ? "Registration closed."
                : "Sorry, this event is full."
              : allClosed
                ? "Registration closed."
                : "Sorry, all events are sold out."}
        </div>
      ) : (
        <CsrfForm action={`/ticket/${slugs.join("+")}`}>
          <Raw html={renderFields(fields)} />
          {hasDaily && dates && <Raw html={renderDateSelector(dates)} />}

          {hideQuantity || isSingleEvent ? (
            <Raw html={eventRows} />
          ) : (
            <fieldset class="ticket-events">
              <legend>Select Tickets</legend>
              <Raw html={eventRows} />
            </fieldset>
          )}

          {questions && questions.length > 0 && (
            <Raw html={renderQuestions(questions, questionEventMap)} />
          )}
          {terms && <Raw html={renderTermsAndCheckbox(terms)} />}
          <button type="submit">{buttonText}</button>
        </CsrfForm>
      )}
    </Layout>,
  );
};
