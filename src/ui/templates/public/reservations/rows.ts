import { t } from "#i18n";
import type { TicketListing } from "#shared/booking/model.ts";
import {
  type BookingNode,
  nodePriceFieldName,
  nodeQuantityFieldName,
} from "#shared/booking/tree.ts";
import type { ListingAttributesById } from "#shared/db/attributes.ts";
import { renderMarkdown } from "#shared/markdown.ts";
// jscpd:ignore-start
import { escapeHtml } from "#templates/layout.tsx";
import { renderListingAttributes } from "../listing-attributes.ts";
import { renderListingImage } from "../shared.tsx";
// jscpd:ignore-end
import {
  type ChildRenderCtx,
  childLimitedMax,
  renderChildBlock,
} from "./child-block.ts";
import {
  type BookingPrefill,
  quantityOptions,
  renderPayMoreInput,
  restoredQuantity,
  type TicketPrefill,
} from "./inputs.ts";

/** Description HTML for a listing row. */
export const renderListingDescription = (description: string): string =>
  description
    ? `<div class="description-compact">${renderMarkdown(description)}</div>`
    : "";

/** The dimmed badge shown in place of booking controls — "Sold out" unless a
 * caller passes other copy (the closed row shows "Registration closed"). */
export const soldOutLabel = (text: string = t("public.sold_out")): string =>
  `<span class="sold-out-label">${text}</span>`;

/** Render quantity selector for an listing row.
 *
 * An optional per-listing `prefill` pre-selects the quantity (clamped to the
 * available range) — used by multi-listing scenarios such as the order cart. */
const listingControls = (
  info: TicketListing,
  node: BookingNode,
  hideQuantity: boolean,
  prefill: TicketPrefill | undefined,
  childCtx: ChildRenderCtx | undefined,
): { childBlock: string; priceHtml: string; quantityHtml: string } => {
  const { listing } = info;
  const maxPurchasable = childLimitedMax(info, childCtx);
  const fieldName = nodeQuantityFieldName(node)!;
  const priceFieldName = nodePriceFieldName(node)!;
  return {
    childBlock: childCtx ? renderChildBlock(info, childCtx) : "",
    priceHtml: listing.can_pay_more
      ? renderPayMoreInput(listing, priceFieldName, prefill?.customPriceMinor)
      : "",
    quantityHtml: hideQuantity
      ? `<input type="hidden" name="${fieldName}" value="1" />`
      : `<select name="${fieldName}">${quantityOptions(
          maxPurchasable,
          restoredQuantity(listing.id, prefill, maxPurchasable),
        )}</select>`,
  };
};

export const renderListingRow = (
  info: TicketListing,
  node: BookingNode,
  hideQuantity = false,
  prefill?: TicketPrefill,
  childCtx?: ChildRenderCtx,
  attributesHtml = "",
): string => {
  const { listing, isSoldOut, isClosed } = info;
  const imageHtml = renderListingImage(listing);

  if (isClosed) {
    return `
      <div class="ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(listing.name)}</label>
        ${attributesHtml}
        ${soldOutLabel(t("public.registration_closed"))}
      </div>
    `;
  }

  if (isSoldOut) {
    return `
      <div class="ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(listing.name)}</label>
        ${renderListingDescription(listing.description)}
        ${attributesHtml}
        ${soldOutLabel()}
      </div>
    `;
  }

  const controls = listingControls(info, node, hideQuantity, prefill, childCtx);

  return `
    <div class="ticket-row">
      ${imageHtml}
      <label>${escapeHtml(listing.name)}${controls.quantityHtml}</label>
      ${renderListingDescription(listing.description)}
      ${attributesHtml}
      ${controls.priceHtml}
      ${controls.childBlock}
    </div>
  `;
};

/** Render controls for a single listing: quantity input + pay-more (no listing name/image/description). */
const renderSingleListingControls = (
  info: TicketListing,
  node: BookingNode,
  hideQuantity: boolean,
  prefill?: TicketPrefill,
  childCtx?: ChildRenderCtx,
): string => {
  const controls = listingControls(info, node, hideQuantity, prefill, childCtx);
  const q = controls.quantityHtml;
  const labelledQuantity = hideQuantity
    ? q
    : `<label>${t("public.ticket.number_of_tickets")}${q}</label>`;
  return `${labelledQuantity}${controls.priceHtml}${controls.childBlock}`;
};

/** Render the per-listing rows (with their child blocks). A single-listing page
 * shows just the controls (details live in the header); multi-listing pages
 * show a compact row each. Both honour per-listing quantity pre-fills.
 * `childCtxFor` suppresses the child block on a row whose listing also has a
 * package member row on the page (that row carries the one child selector). */
export const buildListingRows = (
  listings: TicketListing[],
  nodeByListingId: ReadonlyMap<number, BookingNode>,
  isSingleListing: boolean,
  hideQuantity: boolean,
  prefill: BookingPrefill | undefined,
  childCtxFor: (info: TicketListing) => ChildRenderCtx | undefined,
  attributesByListing: ListingAttributesById = new Map(),
): string =>
  isSingleListing
    ? renderSingleListingControls(
        listings[0]!,
        nodeByListingId.get(listings[0]!.listing.id)!,
        hideQuantity,
        prefill?.listings.get(listings[0]!.listing.id),
        childCtxFor(listings[0]!),
      )
    : listings
        .map((e) => {
          const attributesHtml = renderListingAttributes(
            attributesByListing.get(e.listing.id),
          );
          return renderListingRow(
            e,
            nodeByListingId.get(e.listing.id)!,
            hideQuantity,
            prefill?.listings.get(e.listing.id),
            childCtxFor(e),
            attributesHtml,
          );
        })
        .join("");
