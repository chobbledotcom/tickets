/** Per-listing and per-package row rendering for the ticket page: the listing row
 * (image, name, quantity, child block), the package member row and titled
 * package section, and the top-level builder that lays out a single-package
 * page, a multi-package page, or standalone rows beside packages. */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { TicketListing } from "#shared/booking/model.ts";
import {
  type PagePackage,
  packageMemberIds,
} from "#shared/booking/page-packages.ts";
import {
  type BookingNode,
  nodePriceFieldName,
  nodeQuantityFieldName,
  packageQuantityFieldName,
} from "#shared/booking/tree.ts";
import type { ListingAttributesById } from "#shared/db/attributes.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { escapeHtml } from "#templates/layout.tsx";
import { renderListingAttributes } from "../listing-attributes.ts";
import { renderListingImage } from "../shared.tsx";
import { renderChildBlock } from "./child-block.ts";
import { childLimitedMax } from "./child-pricing.ts";
import { renderPayMoreInput } from "./controls.ts";
import {
  quantityOptions,
  restoredPackageQuantity,
  restoredQuantity,
} from "./quantities.ts";
import type { BookingPrefill, ChildRenderCtx, TicketPrefill } from "./types.ts";

/* jscpd:ignore-end */

/** Description HTML for a listing row. */
const renderListingDescription = (description: string): string =>
  description
    ? `<div class="description-compact">${renderMarkdown(description)}</div>`
    : "";

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

const renderListingRow = (
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
        <span class="sold-out-label">${t("public.registration_closed")}</span>
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
        <span class="sold-out-label">${t("public.sold_out")}</span>
      </div>
    `;
  }

  const { childBlock, priceHtml, quantityHtml } = listingControls(
    info,
    node,
    hideQuantity,
    prefill,
    childCtx,
  );

  return `
    <div class="ticket-row">
      ${imageHtml}
      <label>${escapeHtml(listing.name)}${quantityHtml}</label>
      ${renderListingDescription(listing.description)}
      ${attributesHtml}
      ${priceHtml}
      ${childBlock}
    </div>
  `;
};

/** A package member row: name + fixed per-package quantity, read-only — the
 * buyer chooses the package count, not per-member quantities. A member that is
 * itself a parent renders its child selector under the row, exactly like a
 * standalone parent (only VISIBLE packages may contain parents, so a hidden
 * package never reaches the child block). */
const renderPackageMemberRow = (
  info: TicketListing,
  fixedQty: number,
  childCtx: ChildRenderCtx | undefined,
  attributesHtml = "",
): string => `
    <div class="ticket-row package-member">
      ${renderListingImage(info.listing)}
      <label>${escapeHtml(
        info.listing.name,
      )} <span class="package-member-qty">&times;${fixedQty}</span></label>
      ${renderListingDescription(info.listing.description)}
      ${attributesHtml}
      ${childCtx ? renderChildBlock(info, childCtx) : ""}
    </div>
  `;

/** One package's booking controls: its "number of packages" selector, then each
 * member row (each showing its fixed quantity) — unless the package hides its
 * listings from buyers, in which case only the selector shows. `limit` is the
 * most bundles of this package the buyer can book; `childCtxFor` says whether
 * a member's row carries the parent's child selector (a parent shared by two
 * bundles renders it once — see {@link buildPageListingRows}). */
const renderPackageControls = (
  pkg: PagePackage,
  members: TicketListing[],
  limit: number,
  childCtxFor: (memberListingId: number) => ChildRenderCtx | undefined,
  attributesByListing: ListingAttributesById = new Map(),
): string => {
  // Every member as `id:fixedQty`, so the client knows which listing-scoped
  // questions to show/require once this package is selected — even when
  // members are hidden and render no rows of their own — and how many units
  // each chosen bundle books of a member (the child scripts total a parent's
  // units across every path that books it).
  const memberIds = members
    .map((e) => `${e.listing.id}:${pkg.quantities.get(e.listing.id) ?? 1}`)
    .join(" ");
  const selector = `<label>${t(
    "public.package.quantity",
  )}<select name="${packageQuantityFieldName(
    pkg.groupId,
  )}" data-package-members="${memberIds}">${quantityOptions(
    limit,
    restoredPackageQuantity(pkg.groupId, limit),
  )}</select></label>`;
  const memberRows = pkg.hideListings
    ? ""
    : members
        .map((e) =>
          renderPackageMemberRow(
            e,
            pkg.quantities.get(e.listing.id) ?? 1,
            childCtxFor(e.listing.id),
            renderListingAttributes(attributesByListing.get(e.listing.id)),
          ),
        )
        .join("");
  return selector + memberRows;
};

/** One package as a titled section of a page selling several things: the
 * package's name (and description) above its controls, or a dimmed sold-out
 * card when no whole bundle fits any more — the page stays usable for the
 * other items, matching the order gallery's sold-out cards. */
const renderPackageSection = (
  pkg: PagePackage,
  members: TicketListing[],
  limit: number,
  childCtxFor: (memberListingId: number) => ChildRenderCtx | undefined,
  attributesByListing: ListingAttributesById = new Map(),
): string => {
  const heading = `<legend>${escapeHtml(pkg.name)}</legend>`;
  const body =
    limit < 1
      ? `<span class="sold-out-label">${t("public.sold_out")}</span>`
      : renderListingDescription(pkg.description) +
        renderPackageControls(
          pkg,
          members,
          limit,
          childCtxFor,
          attributesByListing,
        );
  return `<fieldset class="ticket-package${
    limit < 1 ? " sold-out" : ""
  }" data-package-section="${pkg.groupId}">${heading}${body}</fieldset>`;
};

/** Render controls for a single listing: quantity input + pay-more (no listing name/image/description). */
const renderSingleListingControls = (
  info: TicketListing,
  node: BookingNode,
  hideQuantity: boolean,
  prefill?: TicketPrefill,
  childCtx?: ChildRenderCtx,
): string => {
  const { childBlock, priceHtml, quantityHtml } = listingControls(
    info,
    node,
    hideQuantity,
    prefill,
    childCtx,
  );
  const labelledQuantity = hideQuantity
    ? quantityHtml
    : `<label>${t("public.ticket.number_of_tickets")}${quantityHtml}</label>`;
  return `${labelledQuantity}${priceHtml}${childBlock}`;
};

/** Render the per-listing rows (with their child blocks). A single-listing page
 * shows just the controls (details live in the header); multi-listing pages
 * show a compact row each. Both honour per-listing quantity pre-fills.
 * `childCtxFor` suppresses the child block on a row whose listing also has a
 * package member row on the page (that row carries the one child selector). */
const buildListingRows = (
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
        .map((e) =>
          renderListingRow(
            e,
            nodeByListingId.get(e.listing.id)!,
            hideQuantity,
            prefill?.listings.get(e.listing.id),
            childCtxFor(e),
            renderListingAttributes(attributesByListing.get(e.listing.id)),
          ),
        )
        .join("");

/** Build the page's listing area. A page that IS one package (every listing a
 * member, nothing sold beside it) shows that package's count selector plus
 * read-only member rows, as before. A page selling several things shows each
 * package as a titled section, then the per-listing controls for every
 * standalone row — including a member the cart ALSO added on its own, whose
 * child selector stays on its member row so it renders exactly once. */
export const buildPageListingRows = (opts: {
  singlePackagePage: boolean;
  listings: TicketListing[];
  packages: PagePackage[];
  packageLimits: ReadonlyMap<number, number>;
  standaloneRowIds: ReadonlySet<number>;
  nodeByListingId: ReadonlyMap<number, BookingNode>;
  isSingleListing: boolean;
  hideQuantity: boolean;
  prefill?: BookingPrefill | undefined;
  childCtx?: ChildRenderCtx | undefined;
  attributesByListing: ListingAttributesById;
}): string => {
  const { attributesByListing } = opts;
  const membersOf = (pkg: PagePackage): TicketListing[] => {
    const memberIds = new Set(pkg.memberListingIds);
    return opts.listings.filter((info) => memberIds.has(info.listing.id));
  };
  // One child selector per parent across ALL package sections: the first
  // section selling a parent claims its child block, and an overlapping
  // bundle's later row suppresses it — duplicate same-named child fields
  // would silently drop the buyer's chosen mix.
  const claimedChildParents = new Set<number>();
  const claimChildCtx = (
    memberListingId: number,
  ): ChildRenderCtx | undefined => {
    if (claimedChildParents.has(memberListingId)) return undefined;
    claimedChildParents.add(memberListingId);
    return opts.childCtx;
  };
  if (opts.singlePackagePage) {
    const pkg = opts.packages[0]!;
    // packageLimits carries every page package by construction.
    return renderPackageControls(
      pkg,
      membersOf(pkg),
      opts.packageLimits.get(pkg.groupId)!,
      claimChildCtx,
      attributesByListing,
    );
  }
  const packageSections = opts.packages
    .map((pkg) =>
      renderPackageSection(
        pkg,
        membersOf(pkg),
        opts.packageLimits.get(pkg.groupId)!,
        claimChildCtx,
        attributesByListing,
      ),
    )
    .join("");
  const memberIds = packageMemberIds(opts.packages);
  const standalone = opts.listings.filter((info) =>
    opts.standaloneRowIds.has(info.listing.id),
  );
  // A cart of overlapping bundles may have NO standalone rows at all (every
  // listing books through a package) — the sections are the whole page then.
  if (standalone.length === 0) return packageSections;
  return (
    packageSections +
    buildListingRows(
      standalone,
      opts.nodeByListingId,
      // The bare single-listing controls (no name row — details live in the
      // header) only fit a page with nothing else on it. Beside a package
      // section, even a lone standalone row needs its named row, or the buyer
      // sees an unlabelled quantity selector under the bundle.
      opts.isSingleListing && opts.packages.length === 0,
      opts.hideQuantity,
      opts.prefill,
      (info) => (memberIds.has(info.listing.id) ? undefined : opts.childCtx),
      attributesByListing,
    )
  );
};
