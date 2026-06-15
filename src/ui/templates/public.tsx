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
import type {
  QuestionListingMap,
  QuestionWithAnswers,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { getRenewalUrl, isReadOnly } from "#shared/env.ts";
import type { Field } from "#shared/forms.tsx";
import { CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { getIframeMode } from "#shared/iframe.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import {
  availableDayCounts,
  dayPriceFor,
  type Group,
  isPaidListing,
  type ListingFields,
  type ListingWithCount,
} from "#shared/types.ts";
import { getTicketFields, mergeListingFields } from "#templates/fields.ts";
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
        <a href="/">{t("nav.public.home")}</a>
      </li>
      <li>
        <a href="/listings">{t("nav.public.listings")}</a>
      </li>
      {hasTerms && (
        <li>
          <a href="/terms">T&amp;Cs</a>
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
 * contact page has no descriptive text of its own. */
const navFlags = () => ({
  hasContact: !!settings.contactPageText || isContactFormActive(),
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
      <h2>Send us a message</h2>
      <label>
        Your email address
        <input autocomplete="email" name="email" required type="email" />
      </label>
      <label>
        Message
        <textarea
          maxlength={MAX_TEXTAREA_LENGTH}
          name="message"
          required
        ></textarea>
      </label>
      <button type="submit">Send message</button>
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
  const pageTitle = websiteTitle ? `Contact - ${websiteTitle}` : "Contact";
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
          <a href="/admin/login">Login</a>
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
  const bookLabel = listing.purchase_only ? "Buy now" : "Book now";
  const linkHtml = isSoldOut
    ? "<p><strong>Sold Out</strong></p>"
    : isClosed || isReadOnly()
      ? "<p><strong>Registration Closed</strong></p>"
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
    ? "<p><strong>Registration Closed</strong></p>"
    : `<p><a class="btn" href="/ticket/${escapeHtml(
        group.slug,
      )}">Book now</a></p>`;

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
  websiteTitle?: string | null,
  groups: Group[] = [],
): string => {
  const title = websiteTitle ? `Listings - ${websiteTitle}` : "Listings";

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
    ? `<div class="error" role="alert">No dates are currently available for booking.</div>`
    : `<label for="date">Select Date${durationDays > 1 ? ` <small>(each booking reserves ${durationDays} days)</small>` : ""}</label>
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
 * single listing drives the page, each option shows its price for that span. */
const renderDayCountSelector = (
  counts: number[],
  priceFor?: (days: number) => number | null,
): string =>
  counts.length === 0
    ? `<div class="error" role="alert">No booking lengths are currently available.</div>`
    : `<label for="day_count">Number of days</label>
       <select name="day_count" id="day_count" required>
         <option value="">— Select —</option>
         ${counts
           .map((n) => {
             const price = priceFor?.(n);
             const suffix =
               price !== undefined && price !== null
                 ? ` — ${formatCurrency(price)}`
                 : "";
             return `<option value="${n}">${n} day${
               n === 1 ? "" : "s"
             }${suffix}</option>`;
           })
           .join("")}
       </select>`;

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
 * When questionListingMap is provided, adds data-listing-ids
 * so JS can show/hide questions based on selected listing quantities. */
export const renderQuestions = (
  questions: QuestionWithAnswers[],
  questionListingMap?: QuestionListingMap,
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
    <Layout title="QR code expired">
      <div class="prose">
        <h1>QR code expired or invalid</h1>
        <p>
          This QR code has expired or the link has been tampered with. Ask the
          organiser to generate a new one, or use the normal booking page below.
        </p>
        <p>
          <a href={`/ticket/${escapeHtml(slug)}`}>Go to booking page</a>
        </p>
      </div>
    </Layout>,
  );

/**
 * Rate limit page shown on 429 responses for token URLs
 */
export const rateLimitedPage = (): string =>
  String(
    <Layout title="Too Many Requests">
      <div class="prose">
        <h1>Too Many Requests</h1>
        <p>
          You've hit too many invalid ticket links. Please wait a few minutes
          and try again.
        </p>
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
    <Layout headExtra={TEMPORARY_ERROR_HEAD} title="Temporary Error">
      <div class="prose">
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
    <Layout headExtra={MIGRATION_IN_PROGRESS_HEAD} title="Update In Progress">
      <div class="prose">
        <h1>Update In Progress</h1>
        <p>
          We&rsquo;re backing up and updating the database. This usually only
          takes a few seconds. This page will reload automatically&hellip;
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
    <Layout headExtra={ERROR_DIALOG_STYLE} title="Not Activated">
      <div class="prose">
        <h1>Not Activated</h1>
        <p>This site has not been activated yet.</p>
      </div>
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

/** Render quantity selector for an listing row.
 *
 * Note: QR pre-fills are single-listing only and go through
 * renderSingleListingControls, so this function has no prefill parameter. */
const renderListingRow = (
  info: TicketListing,
  hideQuantity = false,
): string => {
  const { listing, isSoldOut, isClosed, maxPurchasable } = info;
  const fieldName = `quantity_${listing.id}`;
  const imageHtml = renderListingImage(listing);

  if (isClosed) {
    return `
      <div class="ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(listing.name)}</label>
        <span class="sold-out-label">Registration Closed</span>
      </div>
    `;
  }

  if (isSoldOut) {
    return `
      <div class="ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(listing.name)}</label>
        ${renderListingDescription(listing.description)}
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

  const showPayMore = listing.can_pay_more;
  const priceFieldName = `custom_price_${listing.id}`;

  return `
    <div class="ticket-row">
      ${imageHtml}
      <label>${escapeHtml(listing.name)}${quantityHtml}</label>
      ${renderListingDescription(listing.description)}
      ${showPayMore ? renderPayMoreInput(listing, priceFieldName) : ""}
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
  const prefilledQty = resolveQuantity(prefill, maxPurchasable);
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

/** Pre-fill state derived from a signed QR booking link */
export type QrPrefill = {
  /** Opaque signed token re-submitted via a hidden input to verify price override */
  token: string;
  /** Pre-fill name input */
  name?: string;
  /** Pre-fill date selector (for daily listings) */
  date?: string;
  /** Per-listing pre-fill — keyed by listing id */
  listings: Map<number, TicketPrefill>;
};

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
  qrPrefill?: QrPrefill;
  /** Override the <form action="…"> URL. Defaults to `/ticket/<slugs>`. */
  actionUrl?: string;
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
              {pastDays} {pastDays === 1 ? "day" : "days"} ago
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
  qrPrefill,
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
        <Raw
          html={renderDateSelector(dates, qrPrefill?.date ?? "", durationDays)}
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
      {terms && <Raw html={renderTermsAndCheckbox(terms)} />}
      <button type="submit">Continue</button>
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
  qrPrefill,
  actionUrl,
}: TicketPageOptions): string => {
  const inIframe = getIframeMode();
  const allUnavailable = listings.every((e) => e.isSoldOut || e.isClosed);
  const allClosed = listings.every((e) => e.isClosed);
  const fieldsSetting = getTicketFieldsSetting(listings);
  const anyPaid = listings.some((e) => isPaidListing(e.listing));
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
  // QR pre-fills only apply to single-listing pages, so multi-listing rows ignore them.
  const listingRows = isSingleListing
    ? renderSingleListingControls(
        listings[0]!,
        hideQuantity,
        qrPrefill?.listings.get(listings[0]!.listing.id),
      )
    : listings.map((e) => renderListingRow(e, hideQuantity)).join("");

  // Unified header. When the caller supplies group metadata (groups, renewals),
  // it takes priority over single-listing details — the caller knows best what
  // page the customer landed on. Plain single-listing ticket pages still fall
  // back to listing name/description since they don't set group metadata.
  const headerName = groupName ?? singleListing?.name;
  const headerDescription = groupDescription ?? singleListing?.description;
  const title = headerName || "Reserve Tickets";
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
          qrPrefill={qrPrefill}
          questionListingMap={questionListingMap}
          questions={questions}
          slugs={slugs}
          terms={terms}
        />
      )}
    </Layout>,
  );
};
