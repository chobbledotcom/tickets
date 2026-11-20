import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { formatCurrency } from "#shared/currency.ts";

/** The price line a product card shows: the "from" prefix for a
 *  pay-what-you-want listing, and nothing when the listing is free. */
export const listingPriceHtml = (listing: {
  canPayMore: boolean;
  unitPrice: number;
}): string =>
  listing.unitPrice > 0
    ? `<span class="card-price">${
        listing.canPayMore ? t("availability.from_prefix") : ""
      }${escapeHtml(formatCurrency(listing.unitPrice))}</span>`
    : "";
