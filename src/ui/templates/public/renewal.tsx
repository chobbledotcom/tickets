/**
 * Renewal page template — displayed at /renew/?t=<token>
 */

import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import type { BuiltSite } from "#shared/db/built-sites.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { EventWithCount } from "#shared/types.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";

type RenewalPageProps = {
  site: BuiltSite;
  tierEvent: EventWithCount;
  token: string;
  error?: string;
};

/** Render the renewal form page */
export const renewalPage = ({
  site,
  tierEvent,
  token,
  error,
}: RenewalPageProps): string => {
  const priceLabel = formatCurrency(toMajorUnits(tierEvent.unit_price));
  const monthsLabel =
    tierEvent.months_per_unit === 1
      ? "month"
      : `${tierEvent.months_per_unit} months`;

  return String(
    <Layout title={`Renew ${site.name}`}>
      <div class="prose">
        <h1>Renew {site.name}</h1>
        {error && <Flash error={error} />}
        {site.readOnlyFrom && (
          <p>
            <strong>Current deadline:</strong>{" "}
            {new Date(site.readOnlyFrom).toLocaleDateString("en-GB")}
          </p>
        )}
        <p>
          <strong>Price:</strong> {priceLabel} per {monthsLabel}
        </p>
        <CsrfForm action={`/renew/?t=${encodeURIComponent(token)}`}>
          <label for="name">Name</label>
          <input id="name" name="name" required type="text" />

          <label for="email">Email</label>
          <input id="email" name="email" required type="email" />

          <label for="quantity">Number of months</label>
          <input
            id="quantity"
            max={tierEvent.max_quantity}
            min="1"
            name="quantity"
            required
            type="number"
            value="1"
          />

          <button type="submit">Pay and Renew</button>
        </CsrfForm>
      </div>
    </Layout>,
  );
};

type RenewalErrorPageProps = {
  siteName: string;
};

/** Render the renewal error page (tier event no longer valid) */
export const renewalErrorPage = ({ siteName }: RenewalErrorPageProps): string =>
  String(
    <Layout title="Renewal Unavailable">
      <div class="prose">
        <h1>Renewal Unavailable</h1>
        <p>
          This renewal link is no longer valid for{" "}
          <strong>{escapeHtml(siteName)}</strong>. Please contact support.
        </p>
      </div>
    </Layout>,
  );
