import { t } from "#i18n";
import type { TicketListing } from "#shared/booking/model.ts";
import { formatDatetimeLabel } from "#shared/dates.ts";
import type { AddOnOption } from "#shared/db/modifier-resolve.ts";
import type { QuestionWithAnswers } from "#shared/db/question-types.ts";
import type { QuestionListingMap } from "#shared/db/questions/queries.ts";
import { isReadOnly } from "#shared/env.ts";
import {
  CsrfForm,
  type Field,
  renderFields,
  savedFormValue,
} from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { mergeListingFields } from "#shared/listing-fields.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type {
  Image,
  ItemImageProjection,
  ListingFields,
  ListingWithCount,
} from "#shared/types.ts";
import { Badge } from "#templates/components/badge.tsx";
import { getTicketFields } from "#templates/fields/ticket.ts";
import { PublicImageGallery, renderListingImage } from "../shared.tsx";
import {
  type BookingPrefill,
  renderDateSelector,
  renderDayCountSelector,
  renderTermsAndCheckbox,
} from "./inputs.ts";
import { renderQuestions } from "./questions.tsx";

/** The merged fields setting across the selected listings. */
const getTicketFieldsSetting = (listings: TicketListing[]): ListingFields =>
  mergeListingFields(listings.map((e) => e.listing.fields));

/**
 * The contact fields rendered on the booking form: every page listing's fields
 * (required) PLUS any extra field a possible child requires. A child with stricter
 * `fields` than its parent (e.g. parent collects email, child also wants
 * phone/address) is validated server-side for the *selected* child, but the buyer
 * must SEE that field to fill it — so it is rendered here NON-required (mirroring
 * the provider-email/`anyPaid` handling), since an unselected child or a
 * zero-quantity parent must not block submission. The page fields keep `required`.
 */
export const buildContactFields = (
  listings: TicketListing[],
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  pagePaid: boolean,
  anyPaid: boolean,
): Field[] => {
  const pageSetting = getTicketFieldsSetting(listings);
  const children = childrenByParentId
    ? [...childrenByParentId.values()].flat()
    : [];
  const childSetting = mergeListingFields(
    children.map((e) => e.listing.fields),
  );
  const mergedSetting = mergeListingFields([pageSetting, childSetting]);
  // The provider-imposed paid email is a required page field only when the PAGE
  // itself is paid; a free page with a paid child renders it non-required (enforced
  // server-side once the folded order is actually paid). So `pageNames` uses
  // `pagePaid` while the rendered set uses `anyPaid` (so the email is present at all).
  const pageNames = new Set<string>(
    getTicketFields(pageSetting, pagePaid).map((f) => f.name),
  );
  return getTicketFields(mergedSetting, anyPaid).map((f) =>
    pageNames.has(f.name) ? f : { ...f, required: false },
  );
};

/** Unavailability message shown when all listings are sold out or closed */
export const unavailableMessage = (
  allClosed: boolean,
  isSingleListing: boolean,
): string => {
  if (isReadOnly() || allClosed) return t("public.ticket.registration_closed");
  return isSingleListing
    ? t("public.ticket.listing_full")
    : t("public.multi.all_sold_out");
};

/** Header block shown above the form with listing/group details */
export const TicketPageHeader = ({
  headerName,
  headerDescription,
  headerImage,
  galleryImages,
  singleListing,
  pastDays,
}: {
  headerName: string;
  headerDescription: string | null | undefined;
  headerImage: ItemImageProjection | null;
  galleryImages: readonly Image[];
  singleListing: ListingWithCount | null;
  pastDays: number | null;
}): JSX.Element => (
  <>
    {/* The full CSS gallery when the header entity has images; otherwise the
        single header-image projection (a listing whose only picture is its
        stored `image_url` with no image_uses rows). */}
    {galleryImages.length > 0 ? (
      <PublicImageGallery images={galleryImages} />
    ) : (
      headerImage && <Raw html={renderListingImage(headerImage)} />
    )}
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
            <Badge variant="alert">
              {" "}
              {t("public.ticket.days_ago", { count: pastDays })}
            </Badge>
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
  </div>
);

/** Form body with fields, date selector, listing rows, questions, terms, and submit */
export const TicketPageForm = ({
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
  isPackage,
  isSingleListing,
  questions,
  questionListingMap,
  terms,
  prefill,
  addOns,
  promoCodesEnabled,
}: {
  slugs: string[];
  actionUrl?: string | undefined;
  fields: Field[];
  hasDaily: boolean;
  durationDays: number;
  dates: string[] | undefined;
  hasCustomisable: boolean;
  dayCounts: number[];
  dayCountPriceFor?: ((days: number) => number | null) | undefined;
  listingRows: string;
  hideQuantity: boolean;
  isPackage: boolean;
  isSingleListing: boolean;
  questions: QuestionWithAnswers[] | undefined;
  questionListingMap: QuestionListingMap | undefined;
  terms: string | null | undefined;
  prefill?: BookingPrefill | undefined;
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

      {hideQuantity || isSingleListing || isPackage ? (
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
          implicit submit (Enter in a text field) completes the booking, not the
          running total's /calculate action. */}
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
