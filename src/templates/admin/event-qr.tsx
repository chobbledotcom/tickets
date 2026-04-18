/**
 * Admin page for generating pre-filled booking QR codes.
 *
 * Admin enters (optional) customer name, price, quantity, and for daily events
 * a date. The server signs a URL and renders the resulting QR inline so the
 * admin can photograph, print, or share it. Links expire 5 minutes after
 * generation.
 */

import { formatCurrency, toMajorUnits } from "#lib/currency.ts";
import { formatDateLabel } from "#lib/dates.ts";
import { CsrfForm, Flash } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { QR_TOKEN_MAX_AGE_S } from "#lib/qr-token.ts";
import type { AdminSession, EventWithCount } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

const EXPIRY_LABEL = `${Math.round(QR_TOKEN_MAX_AGE_S / 60)} minutes`;

/** Values the admin previously submitted, re-rendered on error/success */
export type AdminEventQrValues = {
  customerName: string;
  value: string;
  quantity: string;
  date: string;
};

/** Result of generating a QR (shown alongside the form on success) */
export type AdminEventQrResult = {
  url: string;
  svg: string;
};

/** Options for the admin event-QR page */
export type AdminEventQrPageOptions = {
  event: EventWithCount;
  session: AdminSession;
  bookableDates: string[];
  values: AdminEventQrValues;
  error?: string;
  result?: AdminEventQrResult;
};

/** Render the price input. Can_pay_more events use the configured min/max;
 *  fixed-price events have no upper bound so the admin can set any override. */
const PriceInput = ({
  event,
  value,
}: {
  event: EventWithCount;
  value: string;
}): JSX.Element => {
  const hint = event.can_pay_more
    ? `Minimum ${formatCurrency(event.unit_price)}, maximum ${
      formatCurrency(event.max_price)
    }`
    : `Overrides the ticket price of ${
      formatCurrency(event.unit_price)
    } for this booking`;
  const min = event.can_pay_more ? toMajorUnits(event.unit_price) : "0";
  const max = event.can_pay_more ? toMajorUnits(event.max_price) : undefined;
  return (
    <label>
      Price
      <input
        type="text"
        name="value"
        inputmode="decimal"
        pattern="\d+(\.\d{1,2})?"
        title="A non-negative number (e.g. 10.00)"
        value={value}
        min={min}
        max={max}
      />
      <small>{hint}</small>
    </label>
  );
};

/** Date dropdown for daily events (required) */
const DateSelect = ({
  dates,
  value,
}: {
  dates: string[];
  value: string;
}): JSX.Element => (
  <label>
    Date
    <select name="date" required>
      <option value="">— Select a date —</option>
      {dates.map((d) => (
        <option value={d} selected={d === value}>
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
 * in/out. See src/client/admin/qr-refresh.ts. */
const QrResultPanel = ({
  result,
  refreshUrl,
  formAction,
}: {
  result: AdminEventQrResult;
  refreshUrl: string;
  formAction: string;
}): JSX.Element => (
  <article
    class="qr-result"
    data-qr-refresh={refreshUrl}
    data-qr-refresh-form={formAction}
  >
    <h2>QR code</h2>
    <div class="qr-code" data-qr-svg>
      <Raw html={result.svg} />
    </div>
    <p>
      <small>
        Refreshes every minute. Each code expires {EXPIRY_LABEL} after it was
        generated.
      </small>
    </p>
    <label>
      Link
      <input
        type="text"
        value={result.url}
        readonly
        data-select-on-click
        data-qr-link
      />
    </label>
  </article>
);

/** Admin "generate booking QR code" page */
export const adminEventQrPage = ({
  event,
  session,
  bookableDates,
  values,
  error,
  result,
}: AdminEventQrPageOptions): string => {
  const isDaily = event.event_type === "daily";
  const formAction = `/admin/event/${event.id}/qr`;
  const refreshUrl = `/admin/event/${event.id}/qr.json`;
  return String(
    <Layout title={`QR Code: ${event.name}`}>
      <AdminNav session={session} active="/admin/" />
      <article>
        <h1>
          Booking QR code &mdash;{" "}
          <a href={`/admin/event/${event.id}`}>{event.name}</a>
        </h1>
        <p>
          Generate a signed link that pre-fills the booking form. If name and
          price are both set and the event has no extra required fields, the
          scanner is taken straight to payment.
        </p>
        <Flash error={error} />
        <CsrfForm action={formAction}>
          <label>
            Customer name
            <input
              type="text"
              name="customer_name"
              value={values.customerName}
            />
            <small>Optional &mdash; pre-fills the name field.</small>
          </label>
          <PriceInput event={event} value={values.value} />
          <label>
            Quantity
            <input
              type="number"
              name="quantity"
              min="1"
              max={event.max_quantity}
              value={values.quantity}
              required
            />
          </label>
          {isDaily && <DateSelect dates={bookableDates} value={values.date} />}
          <button type="submit">Generate QR code</button>
        </CsrfForm>
        {result && (
          <QrResultPanel
            result={result}
            refreshUrl={refreshUrl}
            formAction={formAction}
          />
        )}
      </article>
    </Layout>,
  );
};
