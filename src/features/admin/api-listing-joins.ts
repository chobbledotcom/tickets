/**
 * Related listing-data preparation and persistence for the admin API write
 * path. Group links and day prices are written before child edges are
 * checked. All three commit atomically with the listing row.
 */

import {
  listingAttributeOptions,
  missingAttributeOptionIds,
} from "#db/attributes.ts";
import type { TxScope } from "#db/client.ts";
import {
  anyHiddenPackageGroup,
  anyListingInPackageGroup,
  setListingGroupsTx,
} from "#db/groups.ts";
import {
  requireListingChildrenPackageCheck,
  setListingChildrenWithPackageCheckTx,
} from "#db/listing-parents.ts";
import { writeListingDayCounts } from "#db/listing-prices.ts";
import { refuseTheWriteOn } from "#db/transaction.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { listingInputToEdge } from "#shared/listing-edge.ts";
import {
  hasChildEdges,
  packageChildEdgeConflict,
  packageChildEdgeError,
} from "#shared/package-membership.ts";
import type { DayPrices, ListingWithCount } from "#types";
import { validateChildEdges } from "./listings-parents.ts";

/** A placeholder id for a not-yet-created parent. Listing ids are positive
 * autoincrement, so no real listing (and so no real edge) can reference this.
 * The pre-create child-edge validation then behaves exactly as for a parent
 * that does not exist yet. */
const UNCREATED_PARENT_ID = Number.MIN_SAFE_INTEGER;

/** The prepared child-edge write: `null` = leave existing edges untouched
 * (field omitted / feature off). An array = replace the parent's edges with
 * these cleaned ids. */
type PreparedChildEdges = number[] | null;

/** A listing write's related data, prepared before the row write so it commits
 * in the same transaction. */
export type PreparedListingJoins = {
  attributeOptionIds: number[] | undefined;
  childEdges: PreparedChildEdges;
  dayPrices: DayPrices | undefined;
  groupIds: number[] | undefined;
};

/**
 * Interpret the optional `child_listing_ids` field on a write body. The three
 * cases are told apart so a client typo can never silently wipe existing edges.
 * A malformed field fails closed: a 400, with the stored edges left intact.
 */
type SubmittedChildIds =
  | { skip: true }
  | { error: string }
  | { childIds: number[] };

const submittedChildIds = (
  body: Record<string, unknown>,
): SubmittedChildIds => {
  if (body.child_listing_ids === undefined) {
    return { skip: true };
  }
  const raw = body.child_listing_ids;
  if (!Array.isArray(raw)) {
    return { error: "child_listing_ids must be an array of listing ids" };
  }
  // Fail closed on any non-positive-integer entry (a stringified id, float, …)
  // rather than filtering it out. Silently dropping an entry can shrink the
  // array to empty and turn a gated parent into a standalone listing.
  if (
    !raw.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0)
  ) {
    return {
      error: "child_listing_ids must contain only positive integer listing ids",
    };
  }
  return { childIds: raw };
};

/** The listing joins a page save or API write carries, without child edges:
 *  group memberships, day prices, and attribute options from the input. The
 *  page form has no child or attribute fields. The JSON API adds child edges
 *  through {@link prepareChildEdges} when its body carries them. */
export const prepareListingJoins = (
  input: ListingInput,
): PreparedListingJoins => ({
  attributeOptionIds: input.attributeOptionIds,
  childEdges: null,
  dayPrices: input.dayPrices,
  groupIds: input.groupIds,
});

/**
 * Validate a write's `child_listing_ids` against the parent BEFORE the row is
 * written, for atomicity. A rejected edge returns `{ error }` and skips the
 * whole write, so no partial row create/rename remains.
 *
 * The parent {@link EdgeListing} comes from the parsed input via
 * {@link listingInputToEdge}. `bodyToUpdateInput` folds in the existing
 * defaults, so the *fully merged* ListingInput fields are the authoritative
 * post-save values. On create a placeholder id stands in for the missing row.
 * A `null` value means the field is omitted or the parents feature is off.
 * Existing edges stay intact, and a present-but-malformed field is rejected.
 */
export const prepareChildEdges = async (
  body: Record<string, unknown>,
  input: ListingInput,
  existing: ListingWithCount | null,
): Promise<{ error: string } | { childIds: number[] | null }> => {
  const submitted = submittedChildIds(body);
  if ("skip" in submitted) return { childIds: null };
  if ("error" in submitted) return submitted;
  const inputGroupIds = input.wouldBeGroupIds ?? input.groupIds ?? [];
  const packageConflict = await packageChildEdgeConflict(
    submitted.childIds,
    () => anyHiddenPackageGroup(inputGroupIds),
    () => anyListingInPackageGroup(submitted.childIds),
  );
  if (packageConflict) {
    return { error: packageChildEdgeError(packageConflict) };
  }
  // Resolve add-on reachability against the POST-SAVE listing set. Apply the
  // submitted `group_id` to the parent in an in-memory listing set. A parent
  // that joins a child's group-scoped add-on group is then judged by its
  // future group, not the live table that ignores `group_id`.
  // On create the row does not exist yet. The future group still applies
  // to the placeholder id (no live group membership to mislead the check).
  const parentId = existing === null ? UNCREATED_PARENT_ID : existing.id;
  const result = await validateChildEdges(
    listingInputToEdge(input, parentId),
    submitted.childIds,
    { wouldBeGroupIds: inputGroupIds },
  );
  return result.ok ? { childIds: result.childIds } : { error: result.error };
};

/** Write groups and prices before validating child edges against their current
 * transaction-local state. */
export const persistListingJoins = async (
  tx: TxScope,
  listingId: number,
  value: PreparedListingJoins,
): Promise<void> => {
  if (value.attributeOptionIds !== undefined) {
    // The existence check shares the link write's transaction. An option
    // deleted between the request parse and this read cannot leave an orphan
    // id behind. The query is bounded to the submitted ids.
    const missing = await missingAttributeOptionIds(
      tx,
      value.attributeOptionIds,
    );
    refuseTheWriteOn(
      missing.length === 0
        ? null
        : "attribute_option_ids must name existing options",
    );
    await listingAttributeOptions.setIdsTx(
      tx,
      listingId,
      value.attributeOptionIds,
    );
  }
  if (value.groupIds !== undefined) {
    await setListingGroupsTx(
      tx,
      listingId,
      value.groupIds,
      value.childEdges === null ? undefined : hasChildEdges(value.childEdges),
    );
  }
  const childEdges = value.childEdges;
  await writeListingDayCounts(
    tx,
    listingId,
    value.dayPrices,
    childEdges === null
      ? undefined
      : async () =>
          requireListingChildrenPackageCheck(
            await setListingChildrenWithPackageCheckTx(
              tx,
              listingId,
              childEdges,
            ),
          ),
  );
};
