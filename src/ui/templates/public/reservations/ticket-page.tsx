/**
 * Ticket page — register for one or more listings.
 *
 * The single entry point that wires together the booking tree, day-count config,
 * contact fields, package/listing rows, child questions, and the form/header
 * components into a full rendered page. Single listings show rich details (image,
 * description, date, location); multiple listings show a compact row layout with
 * per-listing quantity selectors (or package sections).
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { BuildTreeInput } from "#shared/booking/build-tree.ts";
import { bookableChildIds } from "#shared/booking/model.ts";
import { packageLimitInfo } from "#shared/booking/package-cap.ts";
import { explicitStandaloneIds } from "#shared/booking/page-packages.ts";
import { daysAgo } from "#shared/dates.ts";
import { isReadOnly } from "#shared/env.ts";
import type { Field } from "#shared/forms/field.ts";
import { Flash } from "#shared/forms/flash.tsx";
import { getIframeMode } from "#shared/iframe.ts";
import type { ItemImageProjection, ListingWithCount } from "#shared/types.ts";
import { ErrorNote } from "#templates/components/error.tsx";
import { Layout } from "#templates/layout.tsx";
import {
  buildPageTree,
  headerListing,
  packagePageAvailability,
  unavailableMessage,
} from "./availability.ts";
import {
  buildContactFields,
  pageOrChildPaid,
  pagePaid,
} from "./contact-fields.ts";
import {
  dayConfig,
  resolveDayCountPriceFor,
  splitChildQuestions,
} from "./day-config.ts";
import { TicketPageForm, TicketPageHeader } from "./form.tsx";
import { buildPageListingRows } from "./listing-rows.ts";
import { ticketPageHeadExtra } from "./og-tags.ts";
import type { TicketPageOptions } from "./types.ts";

/* jscpd:ignore-end */

type TicketHeaderInput = {
  attributesByListing: NonNullable<TicketPageOptions["attributesByListing"]>;
  baseUrl: string | undefined;
  groupDescription: string | undefined;
  groupImage: ItemImageProjection | undefined;
  groupName: string | undefined;
  singleListing: ListingWithCount | null;
  slugs: string[];
};

interface TicketHeaderData {
  headExtra: string | undefined;
  headerDescription: string | null | undefined;
  headerImage: ItemImageProjection | null;
  headerName: string | undefined;
  listingAttributes: ReturnType<
    TicketHeaderInput["attributesByListing"]["get"]
  >;
  pastDays: number | null;
  title: string;
}

/** Resolve group-first header details and the single-listing fallback once. */
const resolveTicketHeader = ({
  attributesByListing,
  baseUrl,
  groupDescription,
  groupImage,
  groupName,
  singleListing,
  slugs,
}: TicketHeaderInput): TicketHeaderData => {
  // Caller-supplied group metadata takes priority because the caller knows the
  // page the customer landed on. Plain listing pages fall back to the listing.
  const headerName = groupName ?? singleListing?.name;
  const headerDescription = groupDescription ?? singleListing?.description;
  const headerImage = groupImage?.image_url ? groupImage : singleListing;
  return {
    headExtra: ticketPageHeadExtra(
      headerImage,
      headerName,
      headerDescription,
      slugs,
      baseUrl,
    ),
    headerDescription,
    headerImage,
    headerName,
    listingAttributes: singleListing
      ? attributesByListing.get(singleListing.id)
      : undefined,
    pastDays: singleListing?.date ? daysAgo(singleListing.date) : null,
    title: headerName || t("public.multi.title"),
  };
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
  const paidInput = { addOns, listings, packages, standaloneRowIds };
  const fields: Field[] = buildContactFields(
    listings,
    childrenByParentId,
    pagePaid(paidInput),
    pageOrChildPaid({ ...paidInput, childrenByParentId }),
  );
  const hasDaily = listings.some((e) => e.listing.listing_type === "daily");

  const singleListing = headerListing(listings, packages);
  const isSingleListing = singleListing !== null;

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

  const {
    headExtra,
    headerDescription,
    headerImage,
    headerName,
    listingAttributes,
    pastDays,
    title,
  } = resolveTicketHeader({
    attributesByListing,
    baseUrl,
    groupDescription,
    groupImage,
    groupName,
    singleListing,
    slugs,
  });

  return String(
    <Layout
      bodyClass={inIframe ? "iframe" : undefined}
      contentClassName="public-page"
      headExtra={headExtra}
      title={title}
    >
      {headerName && !inIframe && (
        <TicketPageHeader
          galleryImages={galleryImages}
          headerDescription={headerDescription}
          headerImage={headerImage}
          headerName={headerName}
          listingAttributes={listingAttributes}
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
