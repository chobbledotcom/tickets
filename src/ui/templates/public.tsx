/**
 * Public page templates - ticket reservation pages
 */

import { map, pipe } from "#fp";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import {
  daysAgo,
  formatDateLabel,
  formatDatetimeLabel,
} from "#shared/dates.ts";
import type {
  QuestionEventMap,
  QuestionWithAnswers,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { getRenewalUrl, isReadOnly } from "#shared/env.ts";
import type { Field } from "#shared/forms.tsx";
import { CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { getIframeMode } from "#shared/iframe.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import {
  type EventFields,
  type EventWithCount,
  type Group,
  isPaidEvent,
} from "#shared/types.ts";
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
  hasContact: !!settings.contactPageText,
  hasTerms: !!settings.terms,
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
    contact: "Contact",
    home: "Home",
    terms: "Terms & Conditions",
  };
  const pageTitle = websiteTitle
    ? `${titles[pageType]} - ${websiteTitle}`
    : titles[pageType];

  return String(
    <Layout headExtra={FEED_DISCOVERY_TAGS} title={pageTitle}>
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
  const dateHtml = event.date
    ? `<p><em>${escapeHtml(formatDatetimeLabel(event.date))}</em></p>`
    : "";
  const locationHtml = event.location
    ? `<p><strong>${escapeHtml(event.location)}</strong></p>`
    : "";
  const descriptionHtml = event.description
    ? renderMarkdown(event.description)
    : "";
  const bookLabel = event.purchase_only ? "Buy now" : "Book now";
  const linkHtml = isSoldOut
    ? "<p><strong>Sold Out</strong></p>"
    : isClosed || isReadOnly()
      ? "<p><strong>Registration Closed</strong></p>"
      : `<p><a href="/ticket/${escapeHtml(
          event.slug,
        )}"><strong>${bookLabel}</strong></a></p>`;

  return `<div class="prose"><h2>${escapeHtml(
    event.name,
  )}</h2>${dateHtml}${locationHtml}${descriptionHtml}</div>${linkHtml}`;
};

/** Render a single group listing for the events page (same style as events) */
const renderGroupListing = (group: Group): string => {
  const descriptionHtml = group.description
    ? renderMarkdown(group.description)
    : "";
  const linkHtml = isReadOnly()
    ? "<p><strong>Registration Closed</strong></p>"
    : `<p><a href="/ticket/${escapeHtml(
        group.slug,
      )}"><strong>Book now</strong></a></p>`;

  return `<div class="prose"><h2>${escapeHtml(
    group.name,
  )}</h2>${descriptionHtml}</div>${linkHtml}`;
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
  groups: Group[] = [],
): string => {
  const title = websiteTitle ? `Events - ${websiteTitle}` : "Events";

  if (events.length === 0 && groups.length === 0) {
    return String(
      <Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
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

  const groupListings = pipe(map(renderGroupListing), (rows: string[]) =>
    rows.join(""),
  )(groups);

  const eventListings = pipe(map(renderEventListing), (rows: string[]) =>
    rows.join(""),
  )(events);

  return String(
    <Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...navFlags()} />
      <h2>All bookable events</h2>
      <Raw html={groupListings} />
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
  event: { image_url: string },
  className = "event-image",
): string =>
  event.image_url
    ? `<img src="${escapeHtml(
        getImageProxyUrl(event.image_url),
      )}" alt="" class="${className}" />`
    : "";

/** Build OpenGraph meta tags for a public event page */
export const buildOgTags = (
  event: { name: string; description: string; slug: string; image_url: string },
  baseUrl: string,
): string => {
  const tags = [
    `<meta property="og:title" content="${escapeHtml(event.name)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escapeHtml(baseUrl)}/ticket/${escapeHtml(
      event.slug,
    )}">`,
  ];
  if (event.description) {
    tags.push(
      `<meta property="og:description" content="${escapeHtml(
        event.description,
      )}">`,
    );
  }
  if (event.image_url) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(baseUrl)}${escapeHtml(
        getImageProxyUrl(event.image_url),
      )}">`,
    );
  }
  return tags.join("\n");
};

/** Render a date selector dropdown for daily events */
const renderDateSelector = (dates: string[], selected = ""): string =>
  dates.length === 0
    ? `<div class="error" role="alert">No dates are currently available for booking.</div>`
    : `<label for="date">Select Date</label>
       <select name="date" id="date" required>
         <option value="">— Select a date —</option>
         ${dates
           .map(
             (d) =>
               `<option value="${d}"${d === selected ? " selected" : ""}>${formatDateLabel(
                 d,
               )}</option>`,
           )
           .join("")}
       </select>`;

/** Quantity values parsed from ticket form */
export type TicketQuantities = Map<number, number>;

/** Render a price input for pay-more events */
const renderPayMoreInput = (
  event: Pick<EventWithCount, "unit_price" | "max_price">,
  fieldName = "custom_price",
  prefillMinor?: number,
): string => {
  const minPrice = event.unit_price;
  const maxPrice = event.max_price;
  const rangeHint =
    minPrice > 0
      ? `Price per ticket (${formatCurrency(minPrice)} minimum)`
      : `Price per ticket (optional, up to ${formatCurrency(maxPrice)})`;
  const defaultValue =
    prefillMinor !== undefined && prefillMinor >= minPrice
      ? prefillMinor
      : minPrice;
  return (
    `<label>${rangeHint}` +
    `<input type="text" inputmode="decimal" name="${fieldName}" value="${escapeHtml(
      toMajorUnits(defaultValue),
    )}" min="${escapeHtml(toMajorUnits(minPrice))}" max="${escapeHtml(
      toMajorUnits(maxPrice),
    )}" pattern="\\d+(\\.\\d{1,2})?" title="A non-negative number (e.g. 10.00)"${
      minPrice > 0 ? " required" : ""
    } /></label>`
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
            `<label><input type="radio" name="question_${q.id}" value="${a.id}" required> ${escapeHtml(
              a.text,
            )}</label>`,
        )
        .join("");
      const eventIds = questionEventMap?.get(q.id);
      const eventAttr = eventIds
        ? ` data-event-ids="${eventIds.join(" ")}"`
        : "";
      return `<fieldset class="custom-question"${eventAttr}><legend>${escapeHtml(
        q.text,
      )}</legend>${options}</fieldset>`;
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
 * QR booking link error page shown when a signed link is invalid or expired.
 * Always includes a fallback link to the normal event booking page.
 */
export const qrBookErrorPage = (slug: string): string =>
  String(
    <Layout title="QR code expired">
      <h1>QR code expired or invalid</h1>
      <p>
        This QR code has expired or the link has been tampered with. Ask the
        organiser to generate a new one, or use the normal booking page below.
      </p>
      <p>
        <a href={`/ticket/${escapeHtml(slug)}`}>Go to booking page</a>
      </p>
    </Layout>,
  );

/**
 * Rate limit page shown on 429 responses for token URLs
 */
export const rateLimitedPage = (): string =>
  String(
    <Layout title="Too Many Requests">
      <h1>Too Many Requests</h1>
      <p>
        You've hit too many invalid ticket links. Please wait a few minutes and
        try again.
      </p>
    </Layout>,
  );

/**
 * Inline styles for error dialog pages — self-contained so the page renders
 * correctly even when the database or CDN assets are unavailable
 */
const ERROR_DIALOG_STYLE = `<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f8fafc;color:#0f172a}
main{max-width:36rem;margin:18vh auto 0;padding:0 1.5rem}
h1{font-size:1.875rem;line-height:1.2;margin:0 0 .75rem}
p{line-height:1.5;margin:.75rem 0}
a{color:#0369a1}
</style>`;

/**
 * Temporary error page with auto-refresh
 * Used when a transient CDN or network error occurs
 */
const TEMPORARY_ERROR_HEAD = `<meta http-equiv="refresh" content="2" />
${ERROR_DIALOG_STYLE}`;

export const temporaryErrorPage = (): string =>
  String(
    <Layout headExtra={TEMPORARY_ERROR_HEAD} title="Temporary Error">
      <h1>Temporary Error</h1>
      <p>
        Something went wrong loading this page. Retrying automatically&hellip;
      </p>
      <p>
        <small>
          Check{" "}
          <strong>
            <a href="https://status.bunny.net/">status.bunny.net</a>
          </strong>
        </small>
      </p>
    </Layout>,
  );

/**
 * Shown while another isolate is running a database migration (including its
 * pre-migration backup). Auto-refreshes like the temporary error page, but
 * with a reassuring message so the user knows work is happening rather than
 * seeing a generic error. The backup can take a few seconds on larger
 * databases, so refresh a little slower than the temporary error page.
 */
const MIGRATION_IN_PROGRESS_HEAD = `<meta http-equiv="refresh" content="5" />
${ERROR_DIALOG_STYLE}`;

export const migrationInProgressPage = (): string =>
  String(
    <Layout headExtra={MIGRATION_IN_PROGRESS_HEAD} title="Update In Progress">
      <h1>Update In Progress</h1>
      <p>
        We&rsquo;re backing up and updating the database. This usually only
        takes a few seconds. This page will reload automatically&hellip;
      </p>
    </Layout>,
  );

/**
 * Shown on non-setup routes when the site's database has not been set up
 * yet. No auto-refresh: retrying cannot succeed until someone completes
 * /setup, so an endlessly reloading error page would just be confusing.
 */
export const siteNotActivatedPage = (): string =>
  String(
    <Layout headExtra={ERROR_DIALOG_STYLE} title="Not Activated">
      <h1>Not Activated</h1>
      <p>This site has not been activated yet.</p>
    </Layout>,
  );

/**
 * Read-only mode page
 */
export const readOnlyPage = (): string => {
  const renewalUrl = getRenewalUrl();
  return String(
    <Layout title="Read Only">
      <p>
        This site is in read-only mode.
        {renewalUrl && <Raw html={` <a href="${renewalUrl}">Renew now</a>`} />}
      </p>
    </Layout>,
  );
};

/** Event info for ticket display */
export type TicketEvent = {
  event: EventWithCount;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
};

/** `groupRemaining`, when defined, clamps the displayed sold-out state and
 * `maxPurchasable` to the group's combined cap. */
export const buildTicketEvent = (
  event: EventWithCount,
  closed: boolean,
  groupRemaining: number | undefined,
): TicketEvent => {
  const eventRemaining = event.max_attendees - event.attendee_count;
  const spotsRemaining =
    groupRemaining === undefined
      ? eventRemaining
      : Math.min(eventRemaining, groupRemaining);
  const isSoldOut = spotsRemaining <= 0;
  const maxPurchasable =
    isSoldOut || closed ? 0 : Math.min(event.max_quantity, spotsRemaining);
  return { event, isClosed: closed, isSoldOut, maxPurchasable };
};

/** Render description HTML for event row */
const renderEventDescription = (description: string): string =>
  description
    ? `<div class="description-compact">${renderMarkdown(description)}</div>`
    : "";

/** Per-event pre-fill applied when scanning a signed QR link */
export type TicketPrefill = {
  quantity?: number;
  /** Pre-fill the custom_price input for can_pay_more events (minor units) */
  customPriceMinor?: number;
};

/** Render an <option> list for quantity selectors with the given default selected */
const quantityOptions = (max: number, selected: number): string =>
  Array.from({ length: max + 1 }, (_, i) => i)
    .map(
      (n) =>
        `<option value="${n}"${
          n === selected ? " selected" : ""
        }>${n}</option>`,
    )
    .join("");

/** Resolve the pre-filled quantity value, clamped to the allowed range */
const resolveQuantity = (
  prefill: TicketPrefill | undefined,
  maxPurchasable: number,
): number => {
  if (!prefill?.quantity) return 0;
  return Math.max(0, Math.min(prefill.quantity, maxPurchasable));
};

/** Render quantity selector for an event row.
 *
 * Note: QR pre-fills are single-event only and go through
 * renderSingleEventControls, so this function has no prefill parameter. */
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
    : `<select name="${fieldName}">${quantityOptions(
        maxPurchasable,
        0,
      )}</select>`;

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
  prefill?: TicketPrefill,
): string => {
  const { event, maxPurchasable } = info;
  const fieldName = `quantity_${event.id}`;
  const prefilledQty = resolveQuantity(prefill, maxPurchasable);
  const prefilledPrice = prefill ? prefill.customPriceMinor : undefined;
  const quantityHtml = hideQuantity
    ? `<input type="hidden" name="${fieldName}" value="1" />`
    : `<label>Number of Tickets<select name="${fieldName}">${quantityOptions(
        maxPurchasable,
        prefilledQty,
      )}</select></label>`;
  const showPayMore = event.can_pay_more;
  const priceFieldName = `custom_price_${event.id}`;
  return `${quantityHtml}${
    showPayMore ? renderPayMoreInput(event, priceFieldName, prefilledPrice) : ""
  }`;
};

/**
 * Determine the merged fields setting for the selected events
 */
const getTicketFieldsSetting = (events: TicketEvent[]): EventFields =>
  mergeEventFields(events.map((e) => e.event.fields));

/** Pre-fill state derived from a signed QR booking link */
export type QrPrefill = {
  /** Opaque signed token re-submitted via a hidden input to verify price override */
  token: string;
  /** Pre-fill name input */
  name?: string;
  /** Pre-fill date selector (for daily events) */
  date?: string;
  /** Per-event pre-fill — keyed by event id */
  events: Map<number, TicketPrefill>;
};

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
  groupName?: string;
  groupDescription?: string;
  qrPrefill?: QrPrefill;
  /** Override the <form action="…"> URL. Defaults to `/ticket/<slugs>`. */
  actionUrl?: string;
};

/** Unavailability message shown when all events are sold out or closed */
const unavailableMessage = (
  allClosed: boolean,
  isSingleEvent: boolean,
): string => {
  if (isReadOnly() || allClosed) return "Registration closed.";
  return isSingleEvent
    ? "Sorry, this event is full."
    : "Sorry, all events are sold out.";
};

/** Header block shown above the form with event/group details */
const TicketPageHeader = ({
  headerName,
  headerDescription,
  singleEvent,
  pastDays,
}: {
  headerName: string;
  headerDescription: string | null | undefined;
  singleEvent: EventWithCount | null;
  pastDays: number | null;
}): JSX.Element => (
  <>
    {singleEvent && <Raw html={renderEventImage(singleEvent)} />}
    <div class="prose">
      <h1>{headerName}</h1>
      {headerDescription && (
        <div class="description">
          <Raw html={renderMarkdown(headerDescription)} />
        </div>
      )}
      {singleEvent?.date && (
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
      {singleEvent?.location && (
        <p>
          <strong>Location:</strong> {singleEvent.location}
        </p>
      )}
    </div>
  </>
);

/** Form body with fields, date selector, event rows, questions, terms, and submit */
const TicketPageForm = ({
  slugs,
  actionUrl,
  fields,
  hasDaily,
  dates,
  eventRows,
  hideQuantity,
  isSingleEvent,
  questions,
  questionEventMap,
  terms,
  qrPrefill,
}: {
  slugs: string[];
  actionUrl?: string;
  fields: Field[];
  hasDaily: boolean;
  dates: string[] | undefined;
  eventRows: string;
  hideQuantity: boolean;
  isSingleEvent: boolean;
  questions: QuestionWithAnswers[] | undefined;
  questionEventMap: QuestionEventMap | undefined;
  terms: string | null | undefined;
  qrPrefill?: QrPrefill;
}): JSX.Element => {
  const fieldValues: Record<string, string> = {};
  if (qrPrefill?.name) fieldValues.name = qrPrefill.name;
  return (
    <CsrfForm action={actionUrl ?? `/ticket/${slugs.join("+")}`}>
      {qrPrefill && (
        <input name="qr_token" type="hidden" value={qrPrefill.token} />
      )}
      <Raw html={renderFields(fields, fieldValues)} />
      {hasDaily && dates && (
        <Raw html={renderDateSelector(dates, qrPrefill?.date ?? "")} />
      )}

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
      <button type="submit">Continue</button>
    </CsrfForm>
  );
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
  groupName,
  groupDescription,
  qrPrefill,
  actionUrl,
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
  // QR pre-fills only apply to single-event pages, so multi-event rows ignore them.
  const eventRows = isSingleEvent
    ? renderSingleEventControls(
        events[0]!,
        hideQuantity,
        qrPrefill?.events.get(events[0]!.event.id),
      )
    : events.map((e) => renderEventRow(e, hideQuantity)).join("");

  // Unified header. When the caller supplies group metadata (groups, renewals),
  // it takes priority over single-event details — the caller knows best what
  // page the customer landed on. Plain single-event ticket pages still fall
  // back to event name/description since they don't set group metadata.
  const headerName = groupName ?? singleEvent?.name;
  const headerDescription = groupDescription ?? singleEvent?.description;
  const title = headerName || "Reserve Tickets";
  const headExtra =
    singleEvent && baseUrl ? buildOgTags(singleEvent, baseUrl) : undefined;

  return String(
    <Layout
      bodyClass={inIframe ? "iframe" : undefined}
      headExtra={headExtra}
      title={title}
    >
      {headerName && !inIframe && (
        <TicketPageHeader
          headerDescription={headerDescription}
          headerName={headerName}
          pastDays={pastDays}
          singleEvent={singleEvent}
        />
      )}
      <Flash error={error} />

      {allUnavailable || isReadOnly() ? (
        <div class="error" role="alert">
          {unavailableMessage(allClosed, isSingleEvent)}
        </div>
      ) : (
        <TicketPageForm
          actionUrl={actionUrl}
          dates={dates}
          eventRows={eventRows}
          fields={fields}
          hasDaily={hasDaily}
          hideQuantity={hideQuantity}
          isSingleEvent={isSingleEvent}
          qrPrefill={qrPrefill}
          questionEventMap={questionEventMap}
          questions={questions}
          slugs={slugs}
          terms={terms}
        />
      )}
    </Layout>,
  );
};
