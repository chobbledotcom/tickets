import type { PageCtx } from "#routes/admin/entity-pages.ts";
import {
  getAllAttributesWithOptions,
  listingAttributeOptions,
} from "#shared/db/attributes.ts";
import {
  getAllQuestionsWithAnswers,
  getListingQuestionIds,
} from "#shared/db/questions/queries.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { ListingAttributesPanel } from "#templates/admin/attributes.tsx";
import { ListingQrPanel } from "#templates/admin/listing-qr.tsx";
import { ListingEditPanel } from "#templates/admin/listings/edit-panel.tsx";
import { ListingQuestionsPanel } from "#templates/admin/questions.tsx";
import { loadItemImagesPanel } from "./item-images.ts";
import type { LoadedListing } from "./listing-page-data.ts";
import { EMPTY_QR_VALUES, loadQrFormContext } from "./listing-qr.ts";
import { getListingAndGroups } from "./listings-edit.ts";
import { loadListingParentsSection } from "./listings-parents.ts";

/**
 * Build the Edit tab: the multipart edit form and its side panels. Reloads via
 * getListingAndGroups so the form reads the listing's *stored* values (not the
 * defaults-resolved view the page frame loaded), matching the pre-migration
 * edit page. `error` is set only on a rejected-save in-place re-render.
 */
export const loadListingEditPanel = async (
  { listing }: LoadedListing,
  ctx: PageCtx,
  error?: string,
  selectedGroupIds?: number[],
): Promise<JSX.Element> => {
  // The framework resolved (and 404'd) the listing before this tab loads, so the
  // stored re-fetch the edit form needs always finds the row; assert it rather
  // than carry a null branch this tab can never reach.
  const ctxData = (await getListingAndGroups(listing.id))!;
  const parents = await loadListingParentsSection(ctxData.listing);
  return ListingEditPanel({
    aggregateRecalculation: ctxData.aggregateRecalculation,
    error,
    groups: ctxData.groups,
    listing: ctxData.listing,
    parents,
    // On a rejected save re-render the checkboxes the operator submitted, not
    // the stored set, so their group changes aren't silently dropped.
    selectedGroupIds: selectedGroupIds ?? ctxData.selectedGroupIds,
    session: ctx.session,
  });
};

/** Build the Images tab: current linked images plus upload/existing selection. */
export const loadListingImagesPanel = ({
  listing,
}: LoadedListing): Promise<JSX.Element> =>
  loadItemImagesPanel("listing", listing.id, `/admin/listing/${listing.id}`);

/** A choose-from-a-site-wide-set panel (Questions, Attributes): load every
 *  available item and this listing's selected ids in parallel, then render. The
 *  tab is owner-only (matching the route's own gate). Save feedback arrives as
 *  a redirect flash rendered by the page frame, so the panel carries no error
 *  of its own — an extra loader parameter here would silently receive the
 *  framework's page-context argument instead. */
const listingChoicePanelLoader =
  <Item>(
    loadItems: () => Promise<Item[]>,
    loadSelectedIds: (listingId: number) => Promise<number[]>,
    render: (
      listing: ListingWithCount,
      items: Item[],
      selectedIds: Set<number>,
    ) => JSX.Element,
  ) =>
  async ({ listing }: LoadedListing): Promise<JSX.Element> => {
    const [items, selectedIds] = await Promise.all([
      loadItems(),
      loadSelectedIds(listing.id),
    ]);
    return render(listing, items, new Set(selectedIds));
  };

/** Build the Questions tab: assign the site's questions to this listing. */
export const loadListingQuestionsPanel = listingChoicePanelLoader(
  getAllQuestionsWithAnswers,
  getListingQuestionIds,
  (listing, allQuestions, assignedIds) =>
    ListingQuestionsPanel({ allQuestions, assignedIds, listing }),
);

/** Build the Attributes tab: choose the public attributes displayed for this
 *  listing. */
export const loadListingAttributesPanel = listingChoicePanelLoader(
  getAllAttributesWithOptions,
  listingAttributeOptions.getIds,
  (listing, attributes, selectedOptionIds) =>
    ListingAttributesPanel({ attributes, listing, selectedOptionIds }),
);

/** Build the QR tab: the booking-QR generation form. The tab is hidden for a
 *  child / hidden-package listing (no standalone booking page), so the loader
 *  assumes a QR-eligible listing. */
export const loadListingQrPanel = async ({
  listing,
}: LoadedListing): Promise<JSX.Element> => {
  const { bookableDates, canDirectCheckout } = await loadQrFormContext(listing);
  return ListingQrPanel({
    bookableDates,
    canDirectCheckout,
    listing,
    values: EMPTY_QR_VALUES,
  });
};
