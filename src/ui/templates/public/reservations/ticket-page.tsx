import { t } from "#i18n";
import type { BuildTreeInput } from "#shared/booking/build-tree.ts";
import {
  bookableChildIds,
  type ChildDatesByDayCount,
  type TicketListing,
} from "#shared/booking/model.ts";
import { packageLimitInfo } from "#shared/booking/package-cap.ts";
import {
  explicitStandaloneIds,
  type PagePackage,
} from "#shared/booking/page-packages.ts";
import { daysAgo } from "#shared/dates.ts";
import type { ListingAttributesById } from "#shared/db/attributes.ts";
// jscpd:ignore-start
import type { AddOnOption } from "#shared/db/modifier-resolve.ts";
import type { QuestionWithAnswers } from "#shared/db/question-types.ts";
import type { QuestionListingMap } from "#shared/db/questions/queries.ts";
import { isReadOnly } from "#shared/env.ts";
// jscpd:ignore-end
import { type Field, Flash } from "#shared/forms.tsx";
import { getIframeMode } from "#shared/iframe.ts";
import type { Image, ItemImageProjection } from "#shared/types.ts";
import { ErrorNote } from "#templates/components/error.tsx";
import { Layout } from "#templates/layout.tsx";
import { splitChildQuestions } from "./child-block.ts";
import { buildContactFields } from "./contact-fields.ts";
import { dayConfig, resolveDayCountPriceFor } from "./day-config.ts";
import { TicketPageForm, unavailableMessage } from "./form.tsx";
import { TicketPageHeader } from "./header.tsx";
import type { BookingPrefill } from "./inputs.ts";
import { ticketPageHeadExtra } from "./og.ts";
import { buildPageListingRows } from "./packages.ts";
import {
  buildPageTree,
  headerListing,
  type PaidContext,
  packagePageAvailability,
  pageOrChildPaid,
  pagePaid,
} from "./page-meta.ts";

/** Quantity values parsed from ticket form */
export type TicketQuantities = Map<number, number>;

/** Options for the ticket page */
export type TicketPageOptions = {
  listings: TicketListing[];
  slugs: string[];
  error?: string;
  dates?: string[];
  terms?: string | null;
  questions?: QuestionWithAnswers[];
  questionListingMap?: QuestionListingMap;
  baseUrl?: string;
  groupName?: string;
  groupDescription?: string;
  groupImage?: ItemImageProjection;
  /** The header entity's images, shown as the shared CSS gallery above the
   * form (empty ⇒ falls back to the single header image). */
  galleryImages?: readonly Image[];
  /** Selected listing attributes, populated only on render paths. */
  attributesByListing?: ListingAttributesById;
  prefill?: BookingPrefill | undefined;
  /** Override the <form action="…"> URL. Defaults to `/ticket/<slugs>`. */
  actionUrl?: string;
  /** Opt-in add-ons to offer below the questions. */
  addOns?: AddOnOption[];
  /** Whether to offer a promo-code field. */
  promoCodesEnabled?: boolean;
  /** Parent listing id → its children. Drives the per-parent child selector
   * rendered under each parent row. */
  childrenByParentId?: Map<number, TicketListing[]>;
  /** Daily-child start dates for each parent day count. */
  childDatesById?: ReadonlyMap<string, ChildDatesByDayCount>;
  /** Remaining spots for limited groups. */
  groupRemainingByGroupId?: ReadonlyMap<number, number>;
  /** Groups each listing belongs to. */
  groupIdsByListingId?: ReadonlyMap<number, number[]>;
  /** The package bundles sold on this page, in page order. Each package's
   * members render under its own count selector instead of per-member
   * quantities; listings outside every package keep their own controls. */
  packages?: PagePackage[];
  /** Remaining spots for package member groups. */
  packageGroupRemainingByGroupId?: ReadonlyMap<number, number>;
  packageMemberGroupIds?: ReadonlyMap<number, number[]>;
};

/**
 * Ticket page - register for one or more listings
 * Single listings show rich details (image, description, date, location).
 * Multiple listings show a compact row layout with per-listing quantity selectors.
 */
export const ticketPage = ({
  listings,
  slugs,
  error,
  dates,
  terms,
  questions,
  questionListingMap,
  baseUrl,
  groupName,
  groupDescription,
  groupImage,
  galleryImages = [],
  prefill,
  actionUrl,
  addOns,
  promoCodesEnabled,
  childrenByParentId,
  childDatesById,
  groupRemainingByGroupId = new Map(),
  groupIdsByListingId = new Map(),
  packages = [],
  packageGroupRemainingByGroupId = new Map(),
  packageMemberGroupIds = new Map(),
  attributesByListing = new Map(),
}: TicketPageOptions): string => {
  // The canonical booking tree drives node identity + the stable form field
  // names (via nodeQuantityFieldName/nodePriceFieldName): one node per
  // bookable path, so a member the cart also added by its own slug gets a
  // standalone node (and row) beside its package.
  const treeInput: BuildTreeInput = {
    childrenByParentId,
    listings,
    packages,
    slugs,
    standaloneListingIds: explicitStandaloneIds(
      listings.map((info) => info.listing),
      packages,
      slugs,
    ),
  };
  const { tree, standaloneRowIds, nodeByListingId, singlePackagePage } =
    buildPageTree(treeInput, packages.length);
  const inIframe = getIframeMode();
  const { packageLimits, soldOut: allUnavailable } = packagePageAvailability(
    packages,
    tree,
    listings,
    standaloneRowIds,
    packageLimitInfo(
      listings,
      childrenByParentId,
      packageGroupRemainingByGroupId,
      packageMemberGroupIds,
    ),
  );
  const allClosed = listings.every((e) => e.isClosed);
  const paidCtx: PaidContext = { addOns, packages, standaloneRowIds };
  const fields: Field[] = buildContactFields(
    listings,
    childrenByParentId,
    pagePaid(listings, paidCtx),
    pageOrChildPaid(listings, childrenByParentId, paidCtx),
  );
  const hasDaily = listings.some((e) => e.listing.listing_type === "daily");

  const singleListing = headerListing(listings, packages);
  const isSingleListing = singleListing !== null;
  const pastDays = singleListing?.date ? daysAgo(singleListing.date) : null;

  const dayCfg = dayConfig(
    listings,
    singleListing,
    childrenByParentId,
    packages.length > 0,
  );
  const { hasCustomisable, dayCounts, dateDurationDays } = dayCfg;
  const dayCountPriceFor = resolveDayCountPriceFor(
    singlePackagePage,
    tree,
    bookableChildIds(childrenByParentId),
    dayCfg,
  );

  const availableListings = listings.filter((e) => !e.isSoldOut && !e.isClosed);
  const hideQuantity =
    packages.length === 0 &&
    availableListings.length === 1 &&
    availableListings[0]?.maxPurchasable === 1;

  const { pageQuestions, childCtx } = splitChildQuestions(
    listings,
    questions ?? [],
    questionListingMap,
    childrenByParentId,
    groupRemainingByGroupId,
    childDatesById ?? new Map(),
    groupIdsByListingId,
    attributesByListing,
  );

  // A package page shows one "number of packages" selector plus read-only member
  // rows (each ×its fixed quantity); a mixed page shows each package as a titled
  // section above the per-listing controls.
  const listingRows = buildPageListingRows({
    attributesByListing,
    childCtx,
    hideQuantity,
    isSingleListing,
    listings,
    nodeByListingId,
    packageLimits,
    packages,
    prefill,
    singlePackagePage,
    standaloneRowIds,
  });

  // Caller-supplied group metadata (groups, renewals) takes priority over
  // single-listing details — the caller knows what page the customer landed on.
  // Plain single-listing pages set no group metadata and fall back to listing
  // name/description.
  const headerName = groupName ?? singleListing?.name;
  const headerDescription = groupDescription ?? singleListing?.description;
  const headerImage = groupImage?.image_url ? groupImage : singleListing;
  const title = headerName || t("public.multi.title");
  const headExtra = ticketPageHeadExtra(
    headerImage,
    headerName,
    headerDescription,
    slugs,
    baseUrl,
  );

  return String(
    <Layout
      bodyClass={inIframe ? "iframe" : undefined}
      headExtra={headExtra}
      title={title}
    >
      {headerName && !inIframe && (
        <TicketPageHeader
          galleryImages={galleryImages}
          headerDescription={headerDescription}
          headerImage={headerImage}
          headerName={headerName}
          listingAttributes={
            singleListing
              ? attributesByListing.get(singleListing.id)
              : undefined
          }
          pastDays={pastDays}
          singleListing={singleListing}
        />
      )}
      <Flash error={error} />

      {allUnavailable || isReadOnly() ? (
        <ErrorNote>{unavailableMessage(allClosed, isSingleListing)}</ErrorNote>
      ) : (
        <TicketPageForm
          actionUrl={actionUrl}
          addOns={addOns}
          dates={dates}
          dayCountPriceFor={dayCountPriceFor}
          dayCounts={dayCounts}
          durationDays={dateDurationDays}
          fields={fields}
          hasCustomisable={hasCustomisable}
          hasDaily={hasDaily}
          hideQuantity={hideQuantity}
          isPackage={singlePackagePage}
          isSingleListing={isSingleListing}
          listingRows={listingRows}
          prefill={prefill}
          promoCodesEnabled={promoCodesEnabled}
          questionListingMap={questionListingMap}
          questions={pageQuestions}
          slugs={slugs}
          terms={terms}
        />
      )}
    </Layout>,
  );
};
