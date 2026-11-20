/**
 * The shared media-card body: an optional image on top, then a body column
 * with the item's name and any detail lines. Wrappers choose the element —
 * the order gallery wraps it in a selectable `<label class="card order-card">`
 * and the news list in an `<a class="card news-card">` — so the layout CSS
 * (`.card`, `.card-image`, `.card-body`, `.card-name`) lives once.
 */

import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { formatCurrency } from "#shared/currency.ts";

/** The grid both card collections sit in (`.card-grid` in the stylesheet). */
export const CARD_GRID_CLASS = "card-grid";

/** The price line for a card: the amount, with the "from" prefix when the
 *  listing lets buyers pay more. Empty when the listing has no price. */
export const cardPriceHtml = (listing: {
  unitPrice: number;
  canPayMore: boolean;
}): string =>
  listing.unitPrice > 0
    ? `<span class="card-price">${
        listing.canPayMore ? t("availability.from_prefix") : ""
      }${escapeHtml(formatCurrency(listing.unitPrice))}</span>`
    : "";

export const cardInner = (parts: {
  imageHtml: string;
  name: string;
  detailHtml: string;
}): string =>
  `${parts.imageHtml}
      <span class="card-body">
        <span class="card-name">${escapeHtml(parts.name)}</span>
        ${parts.detailHtml}
      </span>`;
