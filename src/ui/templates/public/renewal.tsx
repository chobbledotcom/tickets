/**
 * Renewal page template — displayed at /renew/?t=<token>
 */

import type { BuiltSite } from "#shared/db/built-sites.ts";
import type { EventWithCount } from "#shared/types.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
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
  const monthsLabel = tierEvent.months_per_unit === 1 ? "month" : `${tierEvent.months_per_unit} months`;

  return String(
    <Layout title={`Renew ${site.name}`}>
      <div class="prose">
        <h1>Renew {site.name}</h1>
        {error && <Flash error={error} />}
        {site.readOnlyFrom && (
          <p>
            <strong>Current deadline:</strong>{" "}
            {new Date(site.readOnlyFrom).toLocaleDateString()}
          </p>
        )}
        <p>
          <strong>Price:</strong> {priceLabel} per {monthsLabel}
        </p>
        <CsrfForm action={`/renew/?t=${encodeURIComponent(token)}`}>
          <label for="name">Name</label>
          <input type="text" name="name" id="name" required />

          <label for="email">Email</label>
          <input type="email" name="email" id="email" required />

          <label for="quantity">Number of months</label>
          <input
            type="number"
            name="quantity"
            id="quantity"
            min="1"
            max={tierEvent.max_quantity}
            value="1"
            required
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
export const renewalErrorPage = ({
  siteName,
}: RenewalErrorPageProps): string =>
  String(
    <Layout title="Renewal Unavailable">
      <div class="prose">
        <h1>Renewal Unavailable</h1>
        <p>
          This renewal link is no longer valid for <strong>{escapeHtml(siteName)}</strong>.
          Please contact support.
        </p>
      </div>
    </Layout>,
  );
