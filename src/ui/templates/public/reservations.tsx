import { t } from "#i18n";
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
import { isReadOnly } from "#shared/env.ts";
import type { Field } from "#shared/forms.tsx";
import {
  CsrfForm,
  Flash,
  renderFields,
  savedFormValue,
} from "#shared/forms.tsx";
import { getIframeMode } from "#shared/iframe.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import {
  availableDayCounts,
  dayPriceFor,
  isPaidListing,
  type ListingFields,
  type ListingWithCount,
} from "#shared/types.ts";
import { getTicketFields, mergeListingFields } from "#templates/fields.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import { renderListingImage, type TicketListing } from "./shared.tsx";
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
    ? `<div class="error" role="alert">${t(
        "public.ticket.no_dates_available",
      )}</div>`
    : `<label for="date">${t("public.ticket.select_date")}${
        durationDays > 1
          ? ` <small>(${t("public.ticket.date_duration_hint", {
              durationDays,
            })})</small>`
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
    return `<div class="error" role="alert">${t(
      "public.ticket.no_booking_lengths",
    )}</div>`;
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
    )}" pattern="\\d+(\\.\\d{1,2})?" title="${escapeHtml(
      t("public.ticket.price_input_title"),
    )}"${minPrice > 0 ? " required" : ""} /></label>`
  );
};

/** Render terms and conditions block with agreement checkbox. The checkbox stays
 * ticked when a validation error re-renders so agreement isn't lost. */
const renderTermsAndCheckbox = (terms: string): string => {
  const checked = savedFormValue("agree_terms") === "1" ? " checked" : "";
  return (
    `<div class="prose">${renderMarkdown(terms)}</div>` +
    `<label class="terms-agree"><input type="checkbox" name="agree_terms" value="1"${checked} required> ${t(
      "public.ticket.agree_terms",
    )}</label>`
  );
};

/** Render custom multiple-choice question fields.
 * When questionListingMap is provided, adds data-listing-ids
 * so JS can show/hide questions based on selected listing quantities. */
export const renderQuestions = (
  questions: QuestionWithAnswers[],
  questionListingMap?: QuestionListingMap,
): JSX.Element => (
  <>
    {questions
      // A choice question whose answers are all deactivated has nothing
      // selectable, so drop it rather than render a required control a buyer
      // can't satisfy (the parser likewise treats it as not applicable).
      .filter(
        (q) =>
          q.display_type === "free_text" || q.answers.some((a) => a.active),
      )
      .map((q) => {
        // Restore the chosen answer when a validation error re-renders the page.
        const answered = savedFormValue(`question_${q.id}`);
        const listingIds = questionListingMap?.get(q.id)?.join(" ");
        // Deactivated answers are never offered on the public booking form.
        const options = q.answers.filter((a) => a.active);
        // A select is a single control, so a plain <label> names it like the text
        // fields do. Radios are a set of controls, so they need a <fieldset> with
        // a <legend> to label the group. Both carry .custom-question (plus any
        // data-listing-ids) so the visibility script can show/hide them.
        if (q.display_type === "free_text") {
          return (
            <label class="custom-question" data-listing-ids={listingIds}>
              {q.text}
              <input
                maxlength={MAX_TEXTAREA_LENGTH}
                name={`question_${q.id}`}
                required
                type="text"
                value={answered}
              />
            </label>
          );
        }
        if (q.display_type === "select") {
          return (
            <label class="custom-question" data-listing-ids={listingIds}>
              {q.text}
              <select name={`question_${q.id}`} required>
                <option value="">
                  {t("public.ticket.select_answer_placeholder")}
                </option>
                {options.map((a) => (
                  <option
                    selected={answered === String(a.id)}
                    value={String(a.id)}
                  >
                    {a.text}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        return (
          <fieldset class="custom-question" data-listing-ids={listingIds}>
            <legend>{q.text}</legend>
            {options.map((a) => (
              <label>
                <input
                  checked={answered === String(a.id)}
                  name={`question_${q.id}`}
                  required
                  type="radio"
                  value={String(a.id)}
                />{" "}
                {a.text}
              </label>
            ))}
          </fieldset>
        );
      })}
  </>
);

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
    : `<label>${t(
        "public.ticket.number_of_tickets",
      )}<select name="${fieldName}">${quantityOptions(
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
          <strong>{t("public.ticket.date_label")}</strong>{" "}
          {formatDatetimeLabel(singleListing.date)}
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
          <strong>{t("public.ticket.location_label")}</strong>{" "}
          {singleListing.location}
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

      {questions &&
        questions.length > 0 &&
        renderQuestions(questions, questionListingMap)}
      {addOns && addOns.length > 0 && <AddOnsFieldset addOns={addOns} />}
      {promoCodesEnabled && <PromoCodeField />}
      {terms && <Raw html={renderTermsAndCheckbox(terms)} />}
      {/* Continue is rendered first so it stays the form's default submit: an
          implicit submit (Enter in a text field) must complete the booking, not
          trigger the running total's /calculate action. */}
      <button type="submit">{t("common.continue")}</button>
      {!actionUrl && (
        <div class="running-total">
          <button
            data-running-total
            formaction={`/calculate/${slugs.join("+")}`}
            formnovalidate
            formtarget="_blank"
            type="submit"
          >
            {t("public.ticket.show_total")}
          </button>
          <output class="order-summary-output" data-running-total-output />
        </div>
      )}
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
