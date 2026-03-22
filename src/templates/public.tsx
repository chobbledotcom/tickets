/**
 * Public page templates - ticket reservation pages
 */

import { map, pipe } from "#fp";
import { formatCurrency, toMajorUnits } from "#lib/currency.ts";
import { formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
import type {
  QuestionEventMap,
  QuestionWithAnswers,
} from "#lib/db/questions.ts";
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
import { t } from "#i18n";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Public site navigation */
const PublicNav = (): JSX.Element => (
  <nav>
    <ul>
      <li>
        <a href="/">{t("nav.public.home")}</a>
      </li>
      <li>
        <a href="/events">{t("nav.public.events")}</a>
      </li>
      <li>
        <a href="/terms">{t("nav.public.terms")}</a>
      </li>
      <li>
        <a href="/contact">{t("nav.public.contact")}</a>
      </li>
    </ul>
  </nav>
);

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
    home: t("public.home"),
    terms: t("public.terms_and_conditions"),
    contact: t("public.contact"),
  };
  const pageTitle = websiteTitle
    ? `${titles[pageType]} - ${websiteTitle}`
    : titles[pageType];

  return String(
    <Layout title={pageTitle} headExtra={FEED_DISCOVERY_TAGS}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav />
      {content ? (
        <Raw html={renderMarkdown(content)} />
      ) : (
        <p>
          <em>{t("public.no_content")}</em>
        </p>
      )}
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">{t("common.login")}</a>
        </p>
      </footer>
    </Layout>,
  );
};

/** Render a single event listing for the events page */
const renderEventListing = (info: MultiTicketEvent): string => {
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
    ? `<p><strong>${escapeHtml(t("public.sold_out"))}</strong></p>`
    : isClosed
      ? `<p><strong>${escapeHtml(t("public.registration_closed"))}</strong></p>`
      : `<p><a href="/ticket/${escapeHtml(event.slug)}"><strong>${escapeHtml(t("public.book_now"))}</strong></a></p>`;

  return `<h2>${escapeHtml(event.name)}</h2>${detailsHtml}${descriptionHtml}${linkHtml}`;
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
  events: MultiTicketEvent[],
  websiteTitle?: string | null,
): string => {
  const title = websiteTitle ? `Events - ${websiteTitle}` : "Events";

  if (events.length === 0) {
    return String(
      <Layout title={title} headExtra={FEED_DISCOVERY_TAGS}>
        {websiteTitle && <h1>{websiteTitle}</h1>}
        <PublicNav />
        <p>
          <em>{t("public.no_events_listed")}</em>
        </p>
        <footer class="homepage-footer">
          <p>
            <a href="/admin/login">{t("common.login")}</a>
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
      <PublicNav />
      <h2>{t("public.all_bookable_events")}</h2>
      <Raw html={eventListings} />
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">{t("common.login")}</a>
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
    ? `<div class="error">${escapeHtml(t("public.ticket.no_dates_available"))}</div>`
    : `<label for="date">${escapeHtml(t("public.ticket.select_date"))}</label>
       <select name="date" id="date" required>
         <option value="">${escapeHtml(t("public.ticket.select_date_placeholder"))}</option>
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

/** Render a price input for pay-more events */
const renderPayMoreInput = (
  event: Pick<EventWithCount, "unit_price" | "max_price">,
  fieldName = "custom_price",
): string => {
  const minPrice = event.unit_price;
  const maxPrice = event.max_price;
  const rangeHint =
    minPrice > 0
      ? t("public.ticket.your_price_min", { min: formatCurrency(minPrice) })
      : t("public.ticket.your_price_optional", { max: formatCurrency(maxPrice) });
  return (
    `<label>${rangeHint}` +
    `<input type="text" inputmode="decimal" name="${fieldName}" value="${escapeHtml(toMajorUnits(minPrice))}" min="${escapeHtml(toMajorUnits(minPrice))}" max="${escapeHtml(toMajorUnits(maxPrice))}"${minPrice > 0 ? " required" : ""} /></label>`
  );
};

/** Render terms and conditions block with agreement checkbox */
const renderTermsAndCheckbox = (terms: string): string =>
  `<div class="terms">${renderMarkdown(terms)}</div>` +
  `<label class="terms-agree"><input type="checkbox" name="agree_terms" value="1" required> ${escapeHtml(t("public.ticket.agree_terms"))}</label>`;

/** Render custom multiple-choice question fields (radio buttons).
 * When questionEventMap is provided (multi-ticket), adds data-event-ids
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
 * Public ticket page
 */
export const ticketPage = (
  event: EventWithCount,
  error: string | undefined,
  isClosed: boolean,
  availableDates: string[] | undefined,
  termsAndConditions: string | null | undefined,
  baseUrl?: string,
  questions?: QuestionWithAnswers[],
): string => {
  const inIframe = getIframeMode();
  const spotsRemaining = event.max_attendees - event.attendee_count;
  const isFull = spotsRemaining <= 0;
  const maxPurchasable = Math.min(event.max_quantity, spotsRemaining);
  const showQuantity = maxPurchasable > 1;
  const fields: Field[] = getTicketFields(event.fields, isPaidEvent(event));
  const isDaily = event.event_type === "daily";
  const headExtra = baseUrl ? buildOgTags(event, baseUrl) : undefined;
  const showPayMore = event.can_pay_more;

  return String(
    <Layout
      title={event.name}
      bodyClass={inIframe ? "iframe" : undefined}
      headExtra={headExtra}
    >
      {!inIframe && (
        <>
          <Raw html={renderEventImage(event)} />
          <h1>{event.name}</h1>
          {event.description && (
            <div class="description">
              <Raw html={renderMarkdownInline(event.description)} />
            </div>
          )}
          {event.date && (
            <p>
              <strong>{t("public.ticket.date_label")}</strong> {formatDatetimeLabel(event.date)}
            </p>
          )}
          {event.location && (
            <p>
              <strong>{t("public.ticket.location_label")}</strong> {event.location}
            </p>
          )}
        </>
      )}
      <Raw html={renderError(error)} />

      {isClosed ? (
        <div class="error">{t("public.ticket.registration_closed")}</div>
      ) : isFull ? (
        <div class="error">{t("public.ticket.event_full")}</div>
      ) : (
        <CsrfForm action={`/ticket/${event.slug}`}>
          <Raw html={renderFields(fields)} />
          {isDaily && availableDates && (
            <Raw html={renderDateSelector(availableDates)} />
          )}
          {showQuantity ? (
            <label>
              {t("public.ticket.number_of_tickets")}
              <select name="quantity">
                <Raw html={quantityOptions(maxPurchasable)} />
              </select>
            </label>
          ) : (
            <input type="hidden" name="quantity" value="1" />
          )}
          {showPayMore && <Raw html={renderPayMoreInput(event)} />}
          {questions && questions.length > 0 && (
            <Raw html={renderQuestions(questions)} />
          )}
          {termsAndConditions && (
            <Raw html={renderTermsAndCheckbox(termsAndConditions)} />
          )}
          <button type="submit">{showQuantity ? t("public.ticket.reserve_tickets") : t("public.ticket.reserve_ticket")}</button>
        </CsrfForm>
      )}
    </Layout>,
  );
};

/**
 * Not found page
 */
export const notFoundPage = (): string =>
  String(
    <Layout title={t("public.not_found.title")}>
      <h1>{t("public.not_found.heading")}</h1>
    </Layout>,
  );

/**
 * Temporary error page with auto-refresh
 * Used when a transient CDN or network error occurs
 */
export const temporaryErrorPage = (): string =>
  String(
    <Layout
      title={t("public.temporary_error.title")}
      headExtra='<meta http-equiv="refresh" content="2" />'
    >
      <h1>{t("public.temporary_error.heading")}</h1>
      <p>
        {t("public.temporary_error.message")}
      </p>
    </Layout>,
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
  const maxPurchasable =
    isSoldOut || closed ? 0 : Math.min(event.max_quantity, spotsRemaining);
  return { event, isSoldOut, isClosed: closed, maxPurchasable };
};

/** Render description HTML for multi-ticket event row */
const renderMultiEventDescription = (description: string): string =>
  description
    ? `<div class="description-compact">${renderMarkdownInline(description)}</div>`
    : "";

/** Render quantity selector for a single event in multi-ticket form */
const renderMultiEventRow = (
  info: MultiTicketEvent,
  hideQuantity = false,
): string => {
  const { event, isSoldOut, isClosed, maxPurchasable } = info;
  const fieldName = `quantity_${event.id}`;
  const imageHtml = renderEventImage(event);

  if (isClosed) {
    return `
      <div class="multi-ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(event.name)}</label>
        <span class="sold-out-label">${escapeHtml(t("public.registration_closed"))}</span>
      </div>
    `;
  }

  if (isSoldOut) {
    return `
      <div class="multi-ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(event.name)}</label>
        ${renderMultiEventDescription(event.description)}
        <span class="sold-out-label">${escapeHtml(t("public.sold_out"))}</span>
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
    <div class="multi-ticket-row">
      ${imageHtml}
      <label>${escapeHtml(event.name)}${quantityHtml}</label>
      ${renderMultiEventDescription(event.description)}
      ${showPayMore ? renderPayMoreInput(event, priceFieldName) : ""}
    </div>
  `;
};

/**
 * Determine the merged fields setting for a set of multi-ticket events
 */
const getMultiTicketFieldsSetting = (events: MultiTicketEvent[]): EventFields =>
  mergeEventFields(events.map((e) => e.event.fields));

/** Options for the multi-ticket page */
export type MultiTicketPageOptions = {
  events: MultiTicketEvent[];
  slugs: string[];
  error?: string;
  dates?: string[];
  terms?: string | null;
  questions?: QuestionWithAnswers[];
  questionEventMap?: QuestionEventMap;
};

/**
 * Multi-ticket page - register for multiple events at once
 */
export const multiTicketPage = ({
  events,
  slugs,
  error,
  dates,
  terms,
  questions,
  questionEventMap,
}: MultiTicketPageOptions): string => {
  const inIframe = getIframeMode();
  const allUnavailable = events.every((e) => e.isSoldOut || e.isClosed);
  const allClosed = events.every((e) => e.isClosed);
  const fieldsSetting = getMultiTicketFieldsSetting(events);
  const anyPaid = events.some((e) => isPaidEvent(e.event));
  const fields: Field[] = getTicketFields(fieldsSetting, anyPaid);
  const hasDaily = events.some((e) => e.event.event_type === "daily");

  const availableEvents = events.filter((e) => !e.isSoldOut && !e.isClosed);
  const hideQuantity =
    availableEvents.length === 1 && availableEvents[0]?.maxPurchasable === 1;

  const eventRows = events
    .map((e) => renderMultiEventRow(e, hideQuantity))
    .join("");

  return String(
    <Layout title={t("public.multi.title")} bodyClass={inIframe ? "iframe" : undefined}>
      <Raw html={renderError(error)} />

      {allUnavailable ? (
        <div class="error">
          {allClosed
            ? t("public.multi.registration_closed")
            : t("public.multi.all_sold_out")}
        </div>
      ) : (
        <CsrfForm action={`/ticket/${slugs.join("+")}`}>
          <Raw html={renderFields(fields)} />
          {hasDaily && dates && <Raw html={renderDateSelector(dates)} />}

          {hideQuantity ? (
            <Raw html={eventRows} />
          ) : (
            <fieldset class="multi-ticket-events">
              <legend>{t("public.multi.select_tickets")}</legend>
              <Raw html={eventRows} />
            </fieldset>
          )}

          {questions && questions.length > 0 && (
            <Raw html={renderQuestions(questions, questionEventMap)} />
          )}
          {terms && <Raw html={renderTermsAndCheckbox(terms)} />}
          <button type="submit">{t("public.multi.reserve_tickets")}</button>
        </CsrfForm>
      )}
    </Layout>,
  );
};
