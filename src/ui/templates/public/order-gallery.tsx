import { map, pipe } from "#fp";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { isReadOnly } from "#shared/env.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { SELECT_PREFIX } from "#shared/order-select.ts";
import { Icon } from "#templates/components/actions.tsx";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import {
  FEED_DISCOVERY_TAGS,
  PublicNav,
  type PublicNavProps,
  renderListingImage,
  type TicketListing,
} from "./shared.tsx";

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
  nav: PublicNavProps,
  websiteTitle?: string | null,
  introText?: string | null,
): string => {
  const orderTitle = t("nav.public.order");
  const title = websiteTitle ? `${orderTitle} - ${websiteTitle}` : orderTitle;
  const cards = pipe(map(renderOrderCard), (rows) => rows.join(""))(listings);

  return String(
    <Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...nav} />
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
