/**
 * Admin page for generating pre-filled booking QR codes.
 *
 * Admin enters (optional) customer name, price, quantity, and for daily listings
 * a date. The server signs a URL and renders the resulting QR inline so the
 * admin can photograph, print, or share it. Links expire 5 minutes after
 * generation.
 */

import { t } from "#i18n";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { QR_TOKEN_MAX_AGE_S } from "#shared/qr-token.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

const EXPIRY_LABEL = `${Math.round(QR_TOKEN_MAX_AGE_S / 60)} minutes`;

/** Values the admin previously submitted, re-rendered on error/success */
export type AdminListingQrValues = {
  customer_name: string;
  value: string;
  quantity: string;
  date: string;
};

/** Result of generating a QR (shown alongside the form on success) */
export type AdminListingQrResult = {
  url: string;
  svg: string;
};

/** Options for the admin listing-QR page */
export type AdminListingQrPageOptions = {
  listing: ListingWithCount;
  session: AdminSession;
  bookableDates: string[];
  values: AdminListingQrValues;
  canDirectCheckout: boolean;
  error?: string;
  result?: AdminListingQrResult;
};

/** Render the price input. Can_pay_more listings use the configured min/max;
 *  fixed-price listings have no upper bound so the admin can set any override. */
const PriceInput = ({
  listing,
  value,
}: {
  listing: ListingWithCount;
  value: string;
}): JSX.Element => {
  const hint = listing.can_pay_more
    ? t("listing_qr.price_hint_can_pay_more", {
        max: formatCurrency(listing.max_price),
        min: formatCurrency(listing.unit_price),
      })
    : t("listing_qr.price_hint_fixed", {
        price: formatCurrency(listing.unit_price),
      });
  const min = listing.can_pay_more ? toMajorUnits(listing.unit_price) : "0";
  const max = listing.can_pay_more
    ? toMajorUnits(listing.max_price)
    : undefined;
  return (
    <label>
      {t("listing_qr.price")}
      <input
        inputmode="decimal"
        max={max}
        min={min}
        name="value"
        pattern="\d+(\.\d{1,2})?"
        title={t("listing_qr.price_input_title")}
        type="text"
        value={value}
      />
      <small>{hint}</small>
    </label>
  );
};

/** Date dropdown for daily listings (required) */
const DateSelect = ({
  dates,
  value,
}: {
  dates: string[];
  value: string;
}): JSX.Element => (
  <label>
    {t("common.date")}
    <select name="date" required>
      <option value="">{t("listing_qr.date_select_placeholder")}</option>
      {dates.map((d) => (
        <option selected={d === value} value={d}>
          {formatDateLabel(d)}
        </option>
      ))}
    </select>
  </label>
);

/** Result panel: QR + copyable URL + expiry note.
 *
 * Data attributes drive client-side auto-refresh: the panel polls the
 * `data-qr-refresh` endpoint every minute and fades the new SVG + URL
 * in/out. See src/ui/client/admin/qr-refresh.ts. */
const QrResultPanel = ({
  result,
  refreshUrl,
  formAction,
}: {
  result: AdminListingQrResult;
  refreshUrl: string;
  formAction: string;
}): JSX.Element => (
  <article
    class="qr-result"
    data-qr-refresh={refreshUrl}
    data-qr-refresh-form={formAction}
  >
    <h2>{t("listing_qr.qr_code")}</h2>
    <div class="qr-code" data-qr-svg>
      <Raw html={result.svg} />
    </div>
    <p>
      <small>{t("listing_qr.qr_expiry_note", { time: EXPIRY_LABEL })}</small>
    </p>
    <label>
      {t("listing_qr.link")}
      <input
        data-qr-link
        data-select-on-click
        readonly
        type="text"
        value={result.url}
      />
    </label>
  </article>
);

/** Admin "generate booking QR code" page */
export const adminListingQrPage = ({
  listing,
  session,
  bookableDates,
  values,
  canDirectCheckout,
  error,
  result,
}: AdminListingQrPageOptions): string => {
  const isDaily = listing.listing_type === "daily";
  const formAction = `/admin/listing/${listing.id}/qr`;
  const refreshUrl = `/admin/listing/${listing.id}/qr.json`;
  return String(
    <Layout title={t("listing_qr.title", { name: listing.name })}>
      <AdminNav active="/admin/" session={session} />
      <article>
        <div class="prose">
          <h1>
            {t("listing_qr.page_title")}{" "}
            <a href={`/admin/listing/${listing.id}`}>{listing.name}</a>
          </h1>
          <p>
            {t("listing_qr.page_description_start")}{" "}
            <span class={canDirectCheckout ? "success-text" : "danger-text"}>
              (
              {t("listing_qr.page_description_condition", {
                state: canDirectCheckout ? "is" : "is not",
              })}
              )
            </span>
            {t("listing_qr.page_description_end")}
          </p>
        </div>
        <Flash {...(error !== undefined ? { error } : {})} />
        <CsrfForm action={formAction}>
          <label>
            {t("listing_qr.customer_name")}
            <input
              name="customer_name"
              type="text"
              value={values.customer_name}
            />
            <small>{t("listing_qr.customer_name_help")}</small>
          </label>
          <PriceInput listing={listing} value={values.value} />
          <label>
            {t("common.quantity")}
            <input
              max={listing.max_quantity}
              min="1"
              name="quantity"
              required
              type="number"
              value={values.quantity}
            />
          </label>
          {isDaily && <DateSelect dates={bookableDates} value={values.date} />}
          <SubmitButton icon="plus">
            {t("listing_qr.generate_button")}
          </SubmitButton>
        </CsrfForm>
        {result && (
          <QrResultPanel
            formAction={formAction}
            refreshUrl={refreshUrl}
            result={result}
          />
        )}
      </article>
    </Layout>,
  );
};
