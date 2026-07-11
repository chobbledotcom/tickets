import { t } from "#i18n";
import type { TicketListing } from "#shared/booking/model.ts";
import {
  type PagePackage,
  packageMemberIds,
} from "#shared/booking/page-packages.ts";
import {
  type BookingNode,
  packageQuantityFieldName,
} from "#shared/booking/tree.ts";
import type { ListingAttributesById } from "#shared/db/attributes.ts";
import { escapeHtml } from "#templates/layout.tsx";
import { renderListingAttributes } from "../listing-attributes.ts";
import { renderListingImage } from "../shared.tsx";
import type { ChildRenderCtx } from "./child-block.ts";
import { renderChildBlock } from "./child-block.ts";
import {
  type BookingPrefill,
  quantityOptions,
  restoredPackageQuantity,
} from "./inputs.ts";
import {
  buildListingRows,
  renderListingDescription,
  soldOutLabel,
} from "./rows.ts";

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

/** Everything a package needs to render: its bundle, the member listings on the
 * page, the buyer's bundle limit, and whether a member's row carries the parent's
 * child selector (a parent shared by two bundles renders it once — see
 * {@link buildPageListingRows}). Shared so the controls and the titled-section
 * renderers present one identical shape. */
type PackageRender = {
  pkg: PagePackage;
  members: TicketListing[];
  limit: number;
  childCtxFor: (memberListingId: number) => ChildRenderCtx | undefined;
  /** Selected listing attributes, for rendering on member rows. */
  attributesByListing: ListingAttributesById;
};

/** One package's booking controls: its "number of packages" selector, then each
 * member row (each showing its fixed quantity) — unless the package hides its
 * listings from buyers, in which case only the selector shows. */
const renderPackageControls = ({
  pkg,
  members,
  limit,
  childCtxFor,
  attributesByListing,
}: PackageRender): string => {
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
const renderPackageSection = (render: PackageRender): string => {
  const { pkg, limit } = render;
  const heading = `<legend>${escapeHtml(pkg.name)}</legend>`;
  const body =
    limit < 1
      ? soldOutLabel()
      : renderListingDescription(pkg.description) +
        renderPackageControls(render);
  return `<fieldset class="ticket-package${
    limit < 1 ? " sold-out" : ""
  }" data-package-section="${pkg.groupId}">${heading}${body}</fieldset>`;
};

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
  // packageLimits carries every page package by construction.
  const renderFor = (pkg: PagePackage): PackageRender => ({
    attributesByListing: opts.attributesByListing,
    childCtxFor: claimChildCtx,
    limit: opts.packageLimits.get(pkg.groupId)!,
    members: membersOf(pkg),
    pkg,
  });
  if (opts.singlePackagePage) {
    return renderPackageControls(renderFor(opts.packages[0]!));
  }
  const packageSections = opts.packages
    .map((pkg) => renderPackageSection(renderFor(pkg)))
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
      opts.attributesByListing,
    )
  );
};
