/**
 * Public page templates - ticket reservation pages
 */

import { map, pipe } from "#fp";
import { t } from "#i18n";
import { CONTACT_JS_PATH } from "#shared/asset-paths.ts";
import { isContactFormActive } from "#shared/contact-form.ts";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import {
  daysAgo,
  formatDateLabel,
  formatDatetimeLabel,
} from "#shared/dates.ts";
import type { AddOnOption } from "#shared/db/modifier-resolve.ts";
import type {
  QuestionListingMap,
  QuestionWithAnswers,
} from "#shared/db/questions.ts";
import { answerPriceLabel } from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { getRenewalUrl, isReadOnly } from "#shared/env.ts";
import type { Field } from "#shared/forms.tsx";
import {
  CsrfForm,
  Flash,
  MessageFields,
  renderFields,
  savedFormValue,
} from "#shared/forms.tsx";
import { getIframeMode } from "#shared/iframe.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { SELECT_PREFIX } from "#shared/order-select.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import {
  availableDayCounts,
  dayPriceFor,
  type Group,
  isPaidListing,
  type ListingFields,
  type ListingWithCount,
} from "#shared/types.ts";
import { Icon } from "#templates/components/actions.tsx";
import { getTicketFields, mergeListingFields } from "#templates/fields.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Public site navigation - hides terms/contact/order links when off/empty */
const PublicNav = ({
  hasTerms,
  hasContact,
  hasOrder,
}: {
  hasTerms?: boolean;
  hasContact?: boolean;
  hasOrder?: boolean;
}): JSX.Element => (
  <nav>
    <ul>
      <li>
        <a href="/">{t("nav.public.home")}</a>
      </li>
      <li>
        <a href="/listings">{t("terms.listings")}</a>
      </li>
      {hasOrder && (
        <li>
          <a href="/order">{t("nav.public.order")}</a>
        </li>
      )}
      {hasTerms && (
        <li>
          <a href="/terms">
            <Raw html={t("nav.public.terms")} />
          </a>
        </li>
      )}
      {hasContact && (
        <li>
          <a href="/contact">{t("nav.public.contact")}</a>
        </li>
      )}
    </ul>
  </nav>
);

/** Compute which public pages have content.
 * The Contact link also shows when the contact form is active, even if the
 * contact page has no descriptive text of its own. The Order link shows
 * whenever the owner has enabled the order page. */
const navFlags = () => ({
  hasContact: !!settings.contactPageText || isContactFormActive(),
  hasOrder: settings.orderEnabled,
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
    contact: t("public.contact"),
    home: t("public.home"),
    terms: t("public.terms_and_conditions"),
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
            <em>{t("public.no_content")}</em>
          </p>
        )}
      </div>
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">{t("common.login")}</a>
        </p>
      </footer>
    </Layout>,
  );
};

/** Message form shown on the public contact page.
 * When a Botpoison public key is supplied it is rendered into a data attribute
 * for the browser widget (the secret key stays server-side for verification);
 * without one the form posts as a plain CSRF-protected form. */
const ContactForm = ({
  botpoisonPublicKey,
}: {
  botpoisonPublicKey: string;
}): JSX.Element => {
  const botpoisonAttr: Record<`data-${string}`, string> = botpoisonPublicKey
    ? { "data-botpoison-public-key": botpoisonPublicKey }
    : {};
  return (
    <CsrfForm action="/contact" {...botpoisonAttr}>
      <h2>{t("public.send_us_a_message")}</h2>
      <label>
        {t("public.contact_email_label")}
        <input autocomplete="email" name="email" required type="email" />
      </label>
      <MessageFields />
    </CsrfForm>
  );
};

/**
 * Public contact page - optional descriptive text plus, when the contact form
 * is active, a message form. The Botpoison widget script is loaded only when a
 * public key is configured (progressive enhancement).
 */
export const contactPage = (options: {
  websiteTitle?: string | null;
  content?: string | null;
  formActive: boolean;
  botpoisonPublicKey: string;
  success?: string;
  error?: string;
}): string => {
  const { websiteTitle, content, formActive, botpoisonPublicKey } = options;
  const contactTitle = t("public.contact");
  const pageTitle = websiteTitle
    ? `${contactTitle} - ${websiteTitle}`
    : contactTitle;
  const loadWidget = formActive && botpoisonPublicKey !== "";
  const headExtra = loadWidget
    ? `${FEED_DISCOVERY_TAGS}\n<script defer src="${CONTACT_JS_PATH}"></script>`
    : FEED_DISCOVERY_TAGS;

  return String(
    <Layout headExtra={headExtra} title={pageTitle}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...navFlags()} />
      <Flash error={options.error} success={options.success} />
      {content && (
        <div class="prose">
          <Raw html={renderMarkdown(content)} />
        </div>
      )}
      {formActive && <ContactForm botpoisonPublicKey={botpoisonPublicKey} />}
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">{t("common.login")}</a>
        </p>
      </footer>
    </Layout>,
  );
};

/** Render a single listing listing for the listings page */
const renderListingListing = (info: TicketListing): string => {
  const { listing, isSoldOut, isClosed } = info;
  const dateHtml = listing.date
    ? `<p><em>${escapeHtml(formatDatetimeLabel(listing.date))}</em></p>`
    : "";
  const locationHtml = listing.location
    ? `<p><strong>${escapeHtml(listing.location)}</strong></p>`
    : "";
  const descriptionHtml = listing.description
    ? renderMarkdown(listing.description)
    : "";
  const bookLabel = listing.purchase_only
    ? t("public.buy_now")
    : t("public.book_now");
  const linkHtml = isSoldOut
    ? `<p><strong>${t("public.sold_out")}</strong></p>`
    : isClosed || isReadOnly()
      ? `<p><strong>${t("public.registration_closed")}</strong></p>`
      : `<p><a class="btn" href="/ticket/${escapeHtml(
          listing.slug,
        )}">${bookLabel}</a></p>`;

  return `<div class="prose"><h2>${escapeHtml(
    listing.name,
  )}</h2>${dateHtml}${locationHtml}${descriptionHtml}</div>${linkHtml}`;
};

/** Render a single group listing for the listings page (same style as listings) */
const renderGroupListing = (group: Group): string => {
  const descriptionHtml = group.description
    ? renderMarkdown(group.description)
    : "";
  const linkHtml = isReadOnly()
    ? `<p><strong>${t("public.registration_closed")}</strong></p>`
    : `<p><a class="btn" href="/ticket/${escapeHtml(
        group.slug,
      )}">${t("public.book_now")}</a></p>`;

  return `<div class="prose"><h2>${escapeHtml(
    group.name,
  )}</h2>${descriptionHtml}</div>${linkHtml}`;
};

/**
 * Homepage with listings - lists all active upcoming listings with booking links
 */
export const RSS_DISCOVERY_TAG =
  '<link rel="alternate" type="application/rss+xml" title="Listings" href="/feeds/listings.rss" />';

export const ICS_DISCOVERY_TAG =
  '<link rel="alternate" type="text/calendar" title="Listings" href="/feeds/listings.ics" />';

export const FEED_DISCOVERY_TAGS = `${RSS_DISCOVERY_TAG}\n${ICS_DISCOVERY_TAG}`;

export const homepagePage = (
  listings: TicketListing[],
  websiteTitle: string | null | undefined,
  groups: Group[],
): string => {
  const listingsTitle = t("terms.listings");
  const title = websiteTitle
    ? `${listingsTitle} - ${websiteTitle}`
    : listingsTitle;

  if (listings.length === 0 && groups.length === 0) {
    return String(
      <Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
        {websiteTitle && <h1>{websiteTitle}</h1>}
        <PublicNav {...navFlags()} />
        <p>
          <em>{t("public.no_listings_listed")}</em>
        </p>
        <footer class="homepage-footer">
          <p>
            <a href="/admin/login">{t("common.login")}</a>
          </p>
        </footer>
      </Layout>,
    );
  }

  const groupListings = pipe(map(renderGroupListing), (rows: string[]) =>
    rows.join(""),
  )(groups);

  const listingListings = pipe(map(renderListingListing), (rows: string[]) =>
    rows.join(""),
  )(listings);

  return String(
    <Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...navFlags()} />
      <h2>{t("public.all_bookable_listings")}</h2>
      <Raw html={groupListings} />
      <Raw html={listingListings} />
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">{t("common.login")}</a>
        </p>
      </footer>
    </Layout>,
  );
};

/** Render listing image HTML if image_url is set */
export const renderListingImage = (
  listing: { image_url: string },
  className = "listing-image",
): string =>
  listing.image_url
    ? `<img src="${escapeHtml(
        getImageProxyUrl(listing.image_url),
      )}" alt="" class="${className}" />`
    : "";

/** Build OpenGraph meta tags for a public listing page */
export const buildOgTags = (
  listing: {
    name: string;
    description: string;
    slug: string;
    image_url: string;
  },
  baseUrl: string,
): string => {
  const tags = [
    `<meta property="og:title" content="${escapeHtml(listing.name)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escapeHtml(baseUrl)}/ticket/${escapeHtml(
      listing.slug,
    )}">`,
  ];
  if (listing.description) {
    tags.push(
      `<meta property="og:description" content="${escapeHtml(
        listing.description,
      )}">`,
    );
  }
  if (listing.image_url) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(baseUrl)}${escapeHtml(
        getImageProxyUrl(listing.image_url),
      )}">`,
    );
  }
  return tags.join("\n");
};

/** Render a date selector dropdown for daily listings */
const renderDateSelector = (
  dates: string[],
  selected = "",
  durationDays = 1,
): string =>
  dates.length === 0
    ? `<div class="error" role="alert">${t("public.ticket.no_dates_available")}</div>`
    : `<label for="date">${t("public.ticket.select_date")}${
        durationDays > 1
          ? ` <small>(${t("public.ticket.date_duration_hint", { durationDays })})</small>`
          : ""
      }</label>
       <select name="date" id="date" required>
         <option value="">${t("public.ticket.select_date_placeholder")}</option>
         ${dates
           .map(
             (d) =>
               `<option value="${d}"${d === selected ? " selected" : ""}>${formatDateLabel(
                 d,
               )}</option>`,
           )
           .join("")}
       </select>`;

/**
 * Shared day-count options across every "customisable days" listing on the
 * page: the intersection of each listing's offered counts so one selector can
 * drive the whole booking (groups enforce a uniform setting, but ad-hoc
 * multi-listing URLs may still mix). Empty when no listing is customisable.
 */
export const sharedDayCounts = (listings: TicketListing[]): number[] => {
  const customisable = listings.filter((e) => e.listing.customisable_days);
  if (customisable.length === 0) return [];
  const sets = customisable.map((e) => new Set(availableDayCounts(e.listing)));
  const [first, ...rest] = sets;
  return [...first!]
    .filter((n) => rest.every((s) => s.has(n)))
    .sort((a, b) => a - b);
};

/** Render the "number of days" selector for customisable-days listings. When a
 * single listing drives the page, each option shows its price for that span.
 * The submitted day count is restored when a validation error re-renders. */
const renderDayCountSelector = (
  counts: number[],
  priceFor?: (days: number) => number | null,
): string => {
  if (counts.length === 0) {
    return `<div class="error" role="alert">${t("public.ticket.no_booking_lengths")}</div>`;
  }
  const selected = savedFormValue("day_count");
  return `<label for="day_count">${t("public.ticket.number_of_days")}</label>
       <select name="day_count" id="day_count" required>
         <option value="">${t("public.ticket.select_placeholder")}</option>
         ${counts
           .map((n) => {
             const price = priceFor?.(n);
             const suffix =
               price !== undefined && price !== null
                 ? ` — ${formatCurrency(price)}`
                 : "";
             return `<option value="${n}"${
               selected === String(n) ? " selected" : ""
             }>${t("public.ticket.day_option", { count: n })}${suffix}</option>`;
           })
           .join("")}
       </select>`;
};

/** Quantity values parsed from ticket form */
export type TicketQuantities = Map<number, number>;

/** Render a price input for pay-more listings */
const renderPayMoreInput = (
  listing: Pick<ListingWithCount, "unit_price" | "max_price">,
  fieldName = "custom_price",
  prefillMinor?: number,
): string => {
  const minPrice = listing.unit_price;
  const maxPrice = listing.max_price;
  const rangeHint =
    minPrice > 0
      ? t("public.ticket.your_price_min", { min: formatCurrency(minPrice) })
      : t("public.ticket.your_price_optional", {
          max: formatCurrency(maxPrice),
        });
  const prefillValue =
    prefillMinor !== undefined && prefillMinor >= minPrice
      ? prefillMinor
      : minPrice;
  // A re-render after a validation error restores exactly what was typed
  // (already in major units); otherwise fall back to the pre-fill/minimum.
  const saved = savedFormValue(fieldName);
  const value = saved !== "" ? saved : toMajorUnits(prefillValue);
  return (
    `<label>${rangeHint}` +
    `<input type="text" inputmode="decimal" name="${fieldName}" value="${escapeHtml(
      value,
    )}" min="${escapeHtml(toMajorUnits(minPrice))}" max="${escapeHtml(
      toMajorUnits(maxPrice),
    )}" pattern="\\d+(\\.\\d{1,2})?" title="A non-negative number (e.g. 10.00)"${
      minPrice > 0 ? " required" : ""
    } /></label>`
  );
};

/** Render terms and conditions block with agreement checkbox. The checkbox stays
 * ticked when a validation error re-renders so agreement isn't lost. */
const renderTermsAndCheckbox = (terms: string): string => {
  const checked = savedFormValue("agree_terms") === "1" ? " checked" : "";
  return (
    `<div class="prose">${renderMarkdown(terms)}</div>` +
    `<label class="terms-agree"><input type="checkbox" name="agree_terms" value="1"${checked} required> ${t("public.ticket.agree_terms")}</label>`
  );
};

/** Render custom multiple-choice question fields (radio buttons).
 * When questionListingMap is provided, adds data-listing-ids
 * so JS can show/hide questions based on selected listing quantities. */
export const renderQuestions = (
  questions: QuestionWithAnswers[],
  questionListingMap?: QuestionListingMap,
): string => {
  if (questions.length === 0) return "";
  return questions
    .map((q) => {
      // Restore the chosen answer when a validation error re-renders the page.
      const answered = savedFormValue(`question_${q.id}`);
      const options = q.answers
        .map(
          (a) =>
            `<label><input type="radio" name="question_${q.id}" value="${a.id}"${
              answered === String(a.id) ? " checked" : ""
            } required> ${escapeHtml(a.text)}${
              answerPriceLabel(a)
                ? ` <small>${escapeHtml(answerPriceLabel(a))}</small>`
                : ""
            }</label>`,
        )
        .join("");
      const listingIds = questionListingMap?.get(q.id);
      const listingAttr = listingIds
        ? ` data-listing-ids="${listingIds.join(" ")}"`
        : "";
      return `<fieldset class="custom-question"${listingAttr}><legend>${escapeHtml(
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
    <Layout title={t("public.not_found.title")}>
      <h1>{t("public.not_found.heading")}</h1>
    </Layout>,
  );

/**
 * QR booking link error page shown when a signed link is invalid or expired.
 * Always includes a fallback link to the normal listing booking page.
 */
export const qrBookErrorPage = (slug: string): string =>
  String(
    <Layout title={t("public.qr_book_error.title")}>
      <div class="prose">
        <h1>{t("public.qr_book_error.heading")}</h1>
        <p>{t("public.qr_book_error.message")}</p>
        <p>
          <a href={`/ticket/${escapeHtml(slug)}`}>
            {t("public.qr_book_error.booking_link")}
          </a>
        </p>
      </div>
    </Layout>,
  );

/**
 * Rate limit page shown on 429 responses for token URLs
 */
export const rateLimitedPage = (): string =>
  String(
    <Layout title={t("public.rate_limited.title")}>
      <div class="prose">
        <h1>{t("public.rate_limited.heading")}</h1>
        <p>{t("public.rate_limited.message")}</p>
      </div>
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
    <Layout
      headExtra={TEMPORARY_ERROR_HEAD}
      title={t("public.temporary_error.title")}
    >
      <div class="prose">
        <h1>{t("public.temporary_error.heading")}</h1>
        <p>{t("public.temporary_error.message")}</p>
        <p>
          <small>
            Check{" "}
            <strong>
              <a href="https://status.bunny.net/">status.bunny.net</a>
            </strong>
          </small>
        </p>
      </div>
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
    <Layout
      headExtra={MIGRATION_IN_PROGRESS_HEAD}
      title={t("public.migration_in_progress.title")}
    >
      <div class="prose">
        <h1>{t("public.migration_in_progress.heading")}</h1>
        <p>
          <Raw html={t("public.migration_in_progress.message")} />
        </p>
      </div>
    </Layout>,
  );

/**
 * Shown on non-setup routes when the site's database has not been set up
 * yet. No auto-refresh: retrying cannot succeed until someone completes
 * /setup, so an endlessly reloading error page would just be confusing.
 */
export const siteNotActivatedPage = (): string =>
  String(
    <Layout
      headExtra={ERROR_DIALOG_STYLE}
      title={t("public.not_activated.title")}
    >
      <div class="prose">
        <h1>{t("public.not_activated.heading")}</h1>
        <p>{t("public.not_activated.message")}</p>
      </div>
    </Layout>,
  );

/**
 * Read-only mode page
 */
export const readOnlyPage = (): string => {
  const renewalUrl = getRenewalUrl();
  return String(
    <Layout title={t("public.read_only.title")}>
      <p>
        {t("public.read_only.message")}
        {renewalUrl && (
          <Raw
            html={` <a href="${escapeHtml(renewalUrl)}">${t("public.read_only.renew_now")}</a>`}
          />
        )}
      </p>
    </Layout>,
  );
};

/** Listing info for ticket display */
export type TicketListing = {
  listing: ListingWithCount;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
};

/** `groupRemaining`, when defined, clamps the displayed sold-out state and
 * `maxPurchasable` to the group's combined cap. */
export const buildTicketListing = (
  listing: ListingWithCount,
  closed: boolean,
  groupRemaining: number | undefined,
): TicketListing => {
  const listingRemaining = listing.max_attendees - listing.attendee_count;
  const spotsRemaining =
    groupRemaining === undefined
      ? listingRemaining
      : Math.min(listingRemaining, groupRemaining);
  const isSoldOut = spotsRemaining <= 0;
  const maxPurchasable =
    isSoldOut || closed ? 0 : Math.min(listing.max_quantity, spotsRemaining);
  return { isClosed: closed, isSoldOut, listing, maxPurchasable };
};

/** Render description HTML for listing row */
const renderListingDescription = (description: string): string =>
  description
    ? `<div class="description-compact">${renderMarkdown(description)}</div>`
    : "";

/** Per-listing pre-fill applied when scanning a signed QR link */
export type TicketPrefill = {
  quantity?: number;
  /** Pre-fill the custom_price input for can_pay_more listings (minor units) */
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

/** The quantity to pre-select for a row: the value the visitor just submitted
 * (restored when a validation error re-renders the page), else the QR/order
 * pre-fill — both clamped to the available range. */
const restoredQuantity = (
  listingId: number,
  prefill: TicketPrefill | undefined,
  maxPurchasable: number,
): number => {
  const saved = savedFormValue(`quantity_${listingId}`);
  if (saved === "") return resolveQuantity(prefill, maxPurchasable);
  return Math.max(0, Math.min(Number.parseInt(saved, 10) || 0, maxPurchasable));
};

/** Render quantity selector for an listing row.
 *
 * An optional per-listing `prefill` pre-selects the quantity (clamped to the
 * available range) — used by multi-listing scenarios such as the order cart. */
const renderListingRow = (
  info: TicketListing,
  hideQuantity = false,
  prefill?: TicketPrefill,
): string => {
  const { listing, isSoldOut, isClosed, maxPurchasable } = info;
  const fieldName = `quantity_${listing.id}`;
  const imageHtml = renderListingImage(listing);

  if (isClosed) {
    return `
      <div class="ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(listing.name)}</label>
        <span class="sold-out-label">${t("public.registration_closed")}</span>
      </div>
    `;
  }

  if (isSoldOut) {
    return `
      <div class="ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(listing.name)}</label>
        ${renderListingDescription(listing.description)}
        <span class="sold-out-label">${t("public.sold_out")}</span>
      </div>
    `;
  }

  const quantityHtml = hideQuantity
    ? `<input type="hidden" name="${fieldName}" value="1" />`
    : `<select name="${fieldName}">${quantityOptions(
        maxPurchasable,
        restoredQuantity(listing.id, prefill, maxPurchasable),
      )}</select>`;

  const showPayMore = listing.can_pay_more;
  const priceFieldName = `custom_price_${listing.id}`;
  const prefilledPrice = prefill ? prefill.customPriceMinor : undefined;

  return `
    <div class="ticket-row">
      ${imageHtml}
      <label>${escapeHtml(listing.name)}${quantityHtml}</label>
      ${renderListingDescription(listing.description)}
      ${
        showPayMore
          ? renderPayMoreInput(listing, priceFieldName, prefilledPrice)
          : ""
      }
    </div>
  `;
};

/** Render controls for a single listing: quantity input + pay-more (no listing name/image/description). */
const renderSingleListingControls = (
  info: TicketListing,
  hideQuantity: boolean,
  prefill?: TicketPrefill,
): string => {
  const { listing, maxPurchasable } = info;
  const fieldName = `quantity_${listing.id}`;
  const prefilledQty = restoredQuantity(listing.id, prefill, maxPurchasable);
  const prefilledPrice = prefill ? prefill.customPriceMinor : undefined;
  const quantityHtml = hideQuantity
    ? `<input type="hidden" name="${fieldName}" value="1" />`
    : `<label>Number of Tickets<select name="${fieldName}">${quantityOptions(
        maxPurchasable,
        prefilledQty,
      )}</select></label>`;
  const showPayMore = listing.can_pay_more;
  const priceFieldName = `custom_price_${listing.id}`;
  return `${quantityHtml}${
    showPayMore
      ? renderPayMoreInput(listing, priceFieldName, prefilledPrice)
      : ""
  }`;
};

/**
 * Determine the merged fields setting for the selected listings
 */
const getTicketFieldsSetting = (listings: TicketListing[]): ListingFields =>
  mergeListingFields(listings.map((e) => e.listing.fields));

/**
 * Context-neutral pre-fill for the booking page: per-listing quantities (and
 * optional price), an optional pre-filled name/date, and — only for signed QR
 * links — a token re-submitted as a hidden field to authorise a price override.
 *
 * This is part of the booking-page framework: any scenario that wants to land a
 * visitor on a booking form with some listings pre-selected builds one of these.
 * The QR booking flow sets a single listing plus a `token`; the order cart sets
 * many listings (quantity 1 each) and no token.
 */
export type BookingPrefill = {
  /** Per-listing pre-fill — keyed by listing id */
  listings: Map<number, TicketPrefill>;
  /** Pre-fill name input */
  name?: string;
  /** Pre-fill date selector (for daily listings) */
  date?: string;
  /** Opaque signed token re-submitted via a hidden input to verify a price
   * override. Only signed QR booking links set this. */
  token?: string;
};

/** Alias retained for the signed-QR booking flow, which always sets `token`. */
export type QrPrefill = BookingPrefill;

/** Options for the ticket page */
export type TicketPageOptions = {
  listings: TicketListing[];
  slugs: string[];
  error?: string;
  dates?: string[];
  terms?: string | null;
  questions?: QuestionWithAnswers[];
  questionListingMap?: QuestionListingMap;
  baseUrl?: string;
  groupName?: string;
  groupDescription?: string;
  prefill?: BookingPrefill;
  /** Override the <form action="…"> URL. Defaults to `/ticket/<slugs>`. */
  actionUrl?: string;
  /** Opt-in add-ons to offer below the questions. */
  addOns?: AddOnOption[];
  /** Whether to offer a promo-code field. */
  promoCodesEnabled?: boolean;
};

/** Unavailability message shown when all listings are sold out or closed */
const unavailableMessage = (
  allClosed: boolean,
  isSingleListing: boolean,
): string => {
  if (isReadOnly() || allClosed) return t("public.ticket.registration_closed");
  return isSingleListing
    ? t("public.ticket.listing_full")
    : t("public.multi.all_sold_out");
};

/** Header block shown above the form with listing/group details */
const TicketPageHeader = ({
  headerName,
  headerDescription,
  singleListing,
  pastDays,
}: {
  headerName: string;
  headerDescription: string | null | undefined;
  singleListing: ListingWithCount | null;
  pastDays: number | null;
}): JSX.Element => (
  <>
    {singleListing && <Raw html={renderListingImage(singleListing)} />}
    <div class="prose">
      <h1>{headerName}</h1>
      {headerDescription && (
        <div class="description">
          <Raw html={renderMarkdown(headerDescription)} />
        </div>
      )}
      {singleListing?.date && (
        <p>
          <strong>Date:</strong> {formatDatetimeLabel(singleListing.date)}
          {pastDays !== null && (
            <span class="badge-alert">
              {" "}
              {t("public.ticket.days_ago", { count: pastDays })}
            </span>
          )}
        </p>
      )}
      {singleListing?.location && (
        <p>
          <strong>Location:</strong> {singleListing.location}
        </p>
      )}
    </div>
  </>
);

/** Opt-in add-on selectors: one quantity input per add-on, defaulting to 0
 * (not selected) and restored on validation error. */
const AddOnsFieldset = ({ addOns }: { addOns: AddOnOption[] }): JSX.Element => (
  <fieldset class="ticket-addons">
    <legend>{t("public.addons.heading")}</legend>
    {addOns.map((addOn) => {
      const field = `addon_${addOn.id}`;
      return (
        <label class="addon-row">
          <span class="addon-name">
            {addOn.name} <span class="addon-price">({addOn.priceLabel})</span>
          </span>
          <input
            aria-label={`${addOn.name} — ${t("public.addons.quantity")}`}
            max={String(addOn.maxQuantity)}
            min="0"
            name={field}
            placeholder="0"
            type="number"
            value={savedFormValue(field)}
          />
        </label>
      );
    })}
  </fieldset>
);

/** Promo-code text input, shown when any active modifier is unlocked by a code.
 * The entered value is restored on a validation-error re-render. */
const PromoCodeField = (): JSX.Element => (
  <div class="promo-code">
    <label>
      {t("public.promo.heading")}
      <input
        name="promo_code"
        placeholder={t("public.promo.placeholder")}
        type="text"
        value={savedFormValue("promo_code")}
      />
    </label>
    <p class="hint">{t("public.promo.hint")}</p>
  </div>
);

/** Form body with fields, date selector, listing rows, questions, terms, and submit */
const TicketPageForm = ({
  slugs,
  actionUrl,
  fields,
  hasDaily,
  durationDays,
  dates,
  hasCustomisable,
  dayCounts,
  dayCountPriceFor,
  listingRows,
  hideQuantity,
  isSingleListing,
  questions,
  questionListingMap,
  terms,
  prefill,
  addOns,
  promoCodesEnabled,
}: {
  slugs: string[];
  actionUrl?: string;
  fields: Field[];
  hasDaily: boolean;
  durationDays: number;
  dates: string[] | undefined;
  hasCustomisable: boolean;
  dayCounts: number[];
  dayCountPriceFor?: (days: number) => number | null;
  listingRows: string;
  hideQuantity: boolean;
  isSingleListing: boolean;
  questions: QuestionWithAnswers[] | undefined;
  questionListingMap: QuestionListingMap | undefined;
  terms: string | null | undefined;
  prefill?: BookingPrefill;
  addOns: AddOnOption[] | undefined;
  promoCodesEnabled: boolean | undefined;
}): JSX.Element => {
  const fieldValues: Record<string, string> = {};
  if (prefill?.name) fieldValues.name = prefill.name;
  return (
    <CsrfForm action={actionUrl ?? `/ticket/${slugs.join("+")}`}>
      {prefill?.token && (
        <input name="qr_token" type="hidden" value={prefill.token} />
      )}
      <Raw html={renderFields(fields, fieldValues)} />
      {hasDaily && dates && (
        <Raw
          html={renderDateSelector(
            dates,
            savedFormValue("date") || prefill?.date || "",
            durationDays,
          )}
        />
      )}
      {hasCustomisable && (
        <Raw html={renderDayCountSelector(dayCounts, dayCountPriceFor)} />
      )}

      {hideQuantity || isSingleListing ? (
        <Raw html={listingRows} />
      ) : (
        <fieldset class="ticket-listings">
          <legend>{t("public.multi.select_tickets")}</legend>
          <Raw html={listingRows} />
        </fieldset>
      )}

      {questions && questions.length > 0 && (
        <Raw html={renderQuestions(questions, questionListingMap)} />
      )}
      {addOns && addOns.length > 0 && <AddOnsFieldset addOns={addOns} />}
      {promoCodesEnabled && <PromoCodeField />}
      {terms && <Raw html={renderTermsAndCheckbox(terms)} />}
      <button type="submit">{t("common.continue")}</button>
    </CsrfForm>
  );
};

/**
 * Day-selection config for the booking form, derived from the page's listings.
 * Customisable-days listings drive a shared "number of days" selector; on a
 * single-listing page each option carries its price, and the date selector's
 * duration label is suppressed because the span is chosen rather than fixed.
 */
const dayConfig = (
  listings: TicketListing[],
  singleListing: ListingWithCount | null,
): {
  hasCustomisable: boolean;
  dayCounts: number[];
  dayCountPriceFor?: (days: number) => number | null;
  dateDurationDays: number;
} => ({
  dateDurationDays:
    singleListing && !singleListing.customisable_days
      ? singleListing.duration_days
      : 1,
  dayCountPriceFor: singleListing?.customisable_days
    ? (days: number) => dayPriceFor(singleListing, days)
    : undefined,
  dayCounts: sharedDayCounts(listings),
  hasCustomisable: listings.some((e) => e.listing.customisable_days),
});

/**
 * Ticket page - register for one or more listings
 * Single listings show rich details (image, description, date, location).
 * Multiple listings show a compact row layout with per-listing quantity selectors.
 */
export const ticketPage = ({
  listings,
  slugs,
  error,
  dates,
  terms,
  questions,
  questionListingMap,
  baseUrl,
  groupName,
  groupDescription,
  prefill,
  actionUrl,
  addOns,
  promoCodesEnabled,
}: TicketPageOptions): string => {
  const inIframe = getIframeMode();
  const allUnavailable = listings.every((e) => e.isSoldOut || e.isClosed);
  const allClosed = listings.every((e) => e.isClosed);
  const fieldsSetting = getTicketFieldsSetting(listings);
  const anyPaid =
    listings.some((e) => isPaidListing(e.listing)) ||
    (addOns?.some((addOn) => addOn.requiresPayment) ?? false);
  const fields: Field[] = getTicketFields(fieldsSetting, anyPaid);
  const hasDaily = listings.some((e) => e.listing.listing_type === "daily");

  const isSingleListing = listings.length === 1;
  const singleListing = isSingleListing ? listings[0]!.listing : null;
  const pastDays = singleListing?.date ? daysAgo(singleListing.date) : null;

  const { hasCustomisable, dayCounts, dayCountPriceFor, dateDurationDays } =
    dayConfig(listings, singleListing);

  const availableListings = listings.filter((e) => !e.isSoldOut && !e.isClosed);
  const hideQuantity =
    availableListings.length === 1 &&
    availableListings[0]?.maxPurchasable === 1;

  // For single listings, render just the quantity/pay-more controls (listing details are in the header).
  // Both single- and multi-listing rows honour per-listing quantity pre-fills,
  // so QR links (single) and the order cart (multi) share the same machinery.
  const listingRows = isSingleListing
    ? renderSingleListingControls(
        listings[0]!,
        hideQuantity,
        prefill?.listings.get(listings[0]!.listing.id),
      )
    : listings
        .map((e) =>
          renderListingRow(
            e,
            hideQuantity,
            prefill?.listings.get(e.listing.id),
          ),
        )
        .join("");

  // Unified header. When the caller supplies group metadata (groups, renewals),
  // it takes priority over single-listing details — the caller knows best what
  // page the customer landed on. Plain single-listing ticket pages still fall
  // back to listing name/description since they don't set group metadata.
  const headerName = groupName ?? singleListing?.name;
  const headerDescription = groupDescription ?? singleListing?.description;
  const title = headerName || t("public.multi.title");
  const headExtra =
    singleListing && baseUrl ? buildOgTags(singleListing, baseUrl) : undefined;

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
          singleListing={singleListing}
        />
      )}
      <Flash error={error} />

      {allUnavailable || isReadOnly() ? (
        <div class="error" role="alert">
          {unavailableMessage(allClosed, isSingleListing)}
        </div>
      ) : (
        <TicketPageForm
          actionUrl={actionUrl}
          addOns={addOns}
          dates={dates}
          dayCountPriceFor={dayCountPriceFor}
          dayCounts={dayCounts}
          durationDays={dateDurationDays}
          fields={fields}
          hasCustomisable={hasCustomisable}
          hasDaily={hasDaily}
          hideQuantity={hideQuantity}
          isSingleListing={isSingleListing}
          listingRows={listingRows}
          prefill={prefill}
          promoCodesEnabled={promoCodesEnabled}
          questionListingMap={questionListingMap}
          questions={questions}
          slugs={slugs}
          terms={terms}
        />
      )}
    </Layout>,
  );
};

/**
 * One listing card in the order gallery. A `<label>` wraps a hidden checkbox so
 * the whole card toggles selection with no JavaScript; CSS highlights the card
 * via `:checked`. Sold-out / closed / read-only listings render a dimmed,
 * non-selectable card so they can't be added to an order.
 */
const renderOrderCard = (info: TicketListing): string => {
  const { listing, isSoldOut, isClosed } = info;
  const imageHtml = renderListingImage(listing, "order-card-image");
  const priceHtml =
    listing.unit_price > 0
      ? `<span class="order-card-price">${
          listing.can_pay_more ? t("availability.from_prefix") : ""
        }${escapeHtml(formatCurrency(listing.unit_price))}</span>`
      : "";

  if (isSoldOut || isClosed || isReadOnly()) {
    const status =
      isSoldOut && !isClosed ? t("public.sold_out") : t("public.unavailable");
    return `<div class="order-card order-card--unavailable">
        ${imageHtml}
        <span class="order-card-body">
          <span class="order-card-name">${escapeHtml(listing.name)}</span>
          <span class="order-card-status">${status}</span>
        </span>
      </div>`;
  }

  const fieldName = `${SELECT_PREFIX}${listing.id}`;
  return `<label class="order-card" for="${fieldName}">
      <input class="order-select" id="${fieldName}" name="${fieldName}" type="checkbox" value="1" />
      ${imageHtml}
      <span class="order-card-body">
        <span class="order-card-name">${escapeHtml(listing.name)}</span>
        ${priceHtml}
      </span>
      <span class="order-card-tick" aria-hidden="true"></span>
    </label>`;
};

/**
 * Order gallery page — a grid of bookable listings the visitor selects to start
 * an order. The whole page is one GET form: each card is a checkbox and the
 * floating cart is the submit button, so submitting navigates to `/order` with
 * the selection, which redirects into the pre-filled multi-listing booking page.
 * Selection styling and the live item count are pure CSS (`:checked`, a counter,
 * and `:has()`), so the page needs no JavaScript. The cart button is placed last
 * in the DOM so its CSS counter sees every checkbox.
 */
export const orderGalleryPage = (
  listings: TicketListing[],
  websiteTitle?: string | null,
  introText?: string | null,
): string => {
  const orderTitle = t("nav.public.order");
  const title = websiteTitle ? `${orderTitle} - ${websiteTitle}` : orderTitle;
  const cards = pipe(map(renderOrderCard), (rows: string[]) => rows.join(""))(
    listings,
  );

  return String(
    <Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...navFlags()} />
      {introText && (
        <div class="prose">
          <Raw html={renderMarkdown(introText)} />
        </div>
      )}
      {listings.length === 0 ? (
        <p>
          <em>{t("public.order.empty")}</em>
        </p>
      ) : (
        <form action="/order" class="order-gallery" method="get">
          <fieldset class="order-grid">
            <legend class="visually-hidden">
              {t("public.select_items_to_order")}
            </legend>
            <Raw html={cards} />
          </fieldset>
          <button class="order-cart" type="submit">
            <Icon name="shopping-cart" />
            <span aria-hidden="true" class="order-cart-count"></span>
            <span class="order-cart-label">{t("public.order.view_order")}</span>
          </button>
        </form>
      )}
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">{t("common.login")}</a>
        </p>
      </footer>
    </Layout>,
  );
};
