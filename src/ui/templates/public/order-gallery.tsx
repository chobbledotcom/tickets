/* jscpd:ignore-start */
import { map, pipe } from "#fp";
import { t } from "#i18n";
import type { TicketListing } from "#shared/booking/model.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { ListingAttributesById } from "#shared/db/attributes.ts";
import { isReadOnly } from "#shared/env.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { listingOptionKey, packageOptionKey } from "#shared/order/options.ts";
import {
  ORDER_FIELD,
  PACKAGE_SELECT_PREFIX,
  SELECT_PREFIX,
  START_DATE_FIELD,
} from "#shared/order-select.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import { Icon, type IconName } from "#templates/components/actions.tsx";
import { CARD_GRID_CLASS, cardInner } from "#templates/components/card.tsx";
import { escapeHtml } from "#templates/layout.tsx";
import { renderListingAttributes } from "./listing-attributes.ts";
import {
  compareGroupsByName,
  PackagesSection,
  type PublicNavProps,
  /* jscpd:ignore-end */
  publicPage,
  renderListingImage,
} from "./shared.tsx";

/**
 * The inner content of an `.order-cart` submit button: the leading {@link Icon},
 * the CSS-driven selection count, and the button label. Shared by the public
 * order gallery and the admin availability checker so the markup lives once.
 */
export const OrderCartButtonBody = ({
  icon,
  label,
}: {
  icon: IconName;
  label: string;
}): JSX.Element => (
  <>
    <Icon name={icon} />
    <span aria-hidden="true" class="order-cart-count"></span>
    <span class="order-cart-label">{label}</span>
  </>
);

/** What the gallery needs to render each card's live availability: whether any
 * option needs a date (so the date field renders), and each option key's
 * server-evaluated status label ("" = plainly selectable). */
export type OrderGalleryStates = {
  anyNeedsDate: boolean;
  labelFor: (key: string) => string;
};

/** A package offered on the order gallery. */
export type OrderGalleryPackage = {
  group: Group;
  members: ListingWithCount[];
};

/** The card body a selectable order card wraps: hidden checkbox, the shared
 * {@link cardInner} (image, name, price/status line, live-state label), and
 * the tick. One shape for listings and packages so the CSS cart mechanics and
 * the enhancement script treat both identically. */
const selectableCard = (parts: {
  fieldName: string;
  key: string;
  imageHtml: string;
  name: string;
  detailHtml: string;
  stateLabel: string;
}): string =>
  `<label class="card order-card" data-order-key="${escapeHtml(
    parts.key,
  )}" for="${parts.fieldName}">
      <input class="order-select" id="${parts.fieldName}" name="${
        parts.fieldName
      }" type="checkbox" value="1" />
      ${cardInner({
        detailHtml: `${parts.detailHtml}
        <span class="order-card-state" data-order-state-label>${escapeHtml(
          parts.stateLabel,
        )}</span>`,
        imageHtml: parts.imageHtml,
        name: parts.name,
      })}
      <span class="order-card-tick" aria-hidden="true"></span>
    </label>`;

/** A dimmed, non-selectable card (sold out / closed / read-only). */
const unavailableCard = (
  imageHtml: string,
  name: string,
  status: string,
  attributesHtml = "",
): string => `<div class="card order-card order-card--unavailable">
        ${cardInner({
          detailHtml: `${attributesHtml}<span class="order-card-status">${status}</span>`,
          imageHtml,
          name,
        })}
      </div>`;

/**
 * One listing card in the order gallery. A `<label>` wraps a hidden checkbox so
 * the whole card toggles selection with no JavaScript; CSS highlights the card
 * via `:checked`. Sold-out / closed / read-only listings render a dimmed,
 * non-selectable card so they can't be added to an order.
 */
const renderOrderCard =
  (states: OrderGalleryStates, attributesByListing: ListingAttributesById) =>
  (info: TicketListing): string => {
    const { listing, isSoldOut, isClosed } = info;
    const imageHtml = renderListingImage(listing, "card-image", {
      thumb: true,
    });
    const priceHtml =
      listing.unit_price > 0
        ? `<span class="order-card-price">${
            listing.can_pay_more ? t("availability.from_prefix") : ""
          }${escapeHtml(formatCurrency(listing.unit_price))}</span>`
        : "";
    const attributesHtml = renderListingAttributes(
      attributesByListing.get(listing.id),
    );

    if (isSoldOut || isClosed || isReadOnly()) {
      const status =
        isSoldOut && !isClosed ? t("public.sold_out") : t("public.unavailable");
      return unavailableCard(imageHtml, listing.name, status, attributesHtml);
    }

    const key = listingOptionKey(listing.id);
    return selectableCard({
      detailHtml: `${priceHtml}${attributesHtml}`,
      fieldName: `${SELECT_PREFIX}${listing.id}`,
      imageHtml,
      key,
      name: listing.name,
      stateLabel: states.labelFor(key),
    });
  };

/**
 * A package card in the order gallery — selectable exactly like a listing
 * card, so packages join the same cart as everything else. The whole-bundle
 * gate already excluded unbookable packages, so a rendered card is selectable
 * unless the site is read-only.
 */
const renderOrderPackageCard =
  (states: OrderGalleryStates) =>
  (pkg: OrderGalleryPackage): string => {
    if (isReadOnly()) {
      return unavailableCard(
        "",
        pkg.group.name,
        t("public.registration_closed"),
      );
    }
    const key = packageOptionKey(pkg.group.id);
    return selectableCard({
      detailHtml: "",
      fieldName: `${PACKAGE_SELECT_PREFIX}${pkg.group.id}`,
      imageHtml: "",
      key,
      name: pkg.group.name,
      stateLabel: states.labelFor(key),
    });
  };

/** The optional date field: shown whenever anything on the page needs a date
 * to be judged (daily listings, packages with daily members), so the visitor
 * can pick one up front and see live availability for it. */
const renderDateField = (): string =>
  `<div class="order-date" data-order-date>
      <label>${escapeHtml(t("public.order.date_label"))}
        <input name="${START_DATE_FIELD}" type="date" />
      </label>
      <span class="order-date-hint" data-order-date-hint>${escapeHtml(
        t("public.order.date_needed"),
      )}</span>
    </div>`;

/**
 * Order gallery page — a grid of bookable listings and packages the visitor
 * selects to start an order. The whole page is one GET form: each card is a
 * checkbox and the floating cart is the submit button, so submitting navigates
 * to `/order` with the selection, which redirects into the pre-filled booking
 * page. Selection styling and the live item count are pure CSS (`:checked`, a
 * counter, and `:has()`), so the page needs no JavaScript; the enhancement
 * script only adds live availability and keeps the order-added field fresh.
 * The cart button is placed last in the DOM so its CSS counter sees every
 * checkbox.
 */
export const orderGalleryPage = (
  listings: TicketListing[],
  packages: OrderGalleryPackage[],
  states: OrderGalleryStates,
  nav: PublicNavProps,
  websiteTitle: string,
  introText?: string | null,
  attributesByListing: ListingAttributesById = new Map(),
): string => {
  const orderTitle = t("nav.public.order");
  const title = websiteTitle ? `${orderTitle} - ${websiteTitle}` : orderTitle;
  const cards = pipe(
    map(renderOrderCard(states, attributesByListing)),
    (rows) => rows.join(""),
  )(listings);
  const packageCards = pipe(map(renderOrderPackageCard(states)), (rows) =>
    rows.join(""),
  )(packages.toSorted((a, b) => compareGroupsByName(a.group, b.group)));

  return publicPage(
    title,
    websiteTitle,
    nav,
  )(
    <>
      {introText && (
        <div class="prose">
          <Raw html={renderMarkdown(introText)} />
        </div>
      )}
      {listings.length === 0 && packages.length === 0 ? (
        <p>
          <em>{t("public.order.empty")}</em>
        </p>
      ) : (
        <form
          action="/order"
          class="order-gallery"
          data-order-gallery
          method="get"
        >
          {states.anyNeedsDate && <Raw html={renderDateField()} />}
          <input name={ORDER_FIELD} type="hidden" value="" />
          {packages.length > 0 && (
            <PackagesSection groups={packages.map((pkg) => pkg.group)}>
              <fieldset class={`${CARD_GRID_CLASS} order-grid`}>
                <legend class="visually-hidden">{t("public.packages")}</legend>
                <Raw html={packageCards} />
              </fieldset>
            </PackagesSection>
          )}
          {listings.length > 0 && (
            <fieldset class={`${CARD_GRID_CLASS} order-grid`}>
              <legend class="visually-hidden">
                {t("public.select_items_to_order")}
              </legend>
              <Raw html={cards} />
            </fieldset>
          )}
          <button class="order-continue" type="submit">
            {t("public.order.continue")}
          </button>
          <button class="order-cart" type="submit">
            <OrderCartButtonBody
              icon="shopping-cart"
              label={t("public.order.view_order")}
            />
          </button>
        </form>
      )}
    </>,
  );
};
