/**
 * Related listing-data preparation and persistence for the admin API write
 * path: group links and day prices are written before child edges are checked,
 * and all three commit atomically with the listing row.
 */

import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import type { TxScope } from "#shared/db/client.ts";
import {
  anyHiddenPackageGroup,
  anyListingInPackageGroup,
  setListingGroupsTx,
} from "#shared/db/groups.ts";
import {
  requireListingChildrenPackageCheck,
  requireTouchingRelationshipsTx,
  setListingChildrenWithPackageCheckTx,
} from "#shared/db/listing-parents.ts";
import { writeListingDayCounts } from "#shared/db/listing-prices.ts";
import { listingInputToEdge } from "#shared/listings-actions.ts";
import {
  hasChildEdges,
  packageChildEdgeConflict,
  packageChildEdgeError,
} from "#shared/package-membership.ts";
import type { DayPrices, ListingWithCount } from "#shared/types.ts";
import { validateChildEdges } from "./listings-parents.ts";

/** A placeholder id for a not-yet-created parent: listing ids are positive
 * autoincrement, so no real listing (and so no real edge) can reference this,
 * making the pre-create child-edge validation behave exactly as for a parent
 * that doesn't exist yet. */
const UNCREATED_PARENT_ID = Number.MIN_SAFE_INTEGER;

/** The prepared child-edge write: `null` = leave existing edges untouched
 * (field omitted / feature off); an array = replace the parent's edges with
 * these cleaned ids. */
type PreparedChildEdges = number[] | null;

/** A listing write's related data, prepared before the row write so it commits
 * in the same transaction. */
export type PreparedListingJoins = {
  childEdges: PreparedChildEdges;
  dayPrices: DayPrices | undefined;
  groupIds: number[] | undefined;
};

/**
 * Interpret the optional `child_listing_ids` field on a write body, telling
 * three cases apart so a client typo can never silently wipe existing edges:
 * - `{ skip: true }` — the parents feature is off or the field is omitted, so
 *   the API leaves the listing's existing edges untouched;
 * - `{ error }` — the field is present but malformed: not an array (a string,
 *   object, …), or an array containing any entry that is not a positive integer
 *   listing id (e.g. a JSON client sending `["7"]`). Both are reported as a 400
 *   with the edges left intact — failing closed, so a typo can never silently
 *   wipe a gated parent's edges down to an empty replacement;
 * - `{ childIds }` — a real array of positive integer ids, ready for
 *   {@link writeChildEdges} (self-edges and unknown ids are still dropped
 *   downstream by {@link validateChildEdges}).
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
  // rather than filtering it out: silently dropping it could shrink the array to
  // empty and turn a gated parent into a standalone listing.
  if (
    !raw.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0)
  ) {
    return {
      error: "child_listing_ids must contain only positive integer listing ids",
    };
  }
  return { childIds: raw };
};

/**
 * Validate a write's `child_listing_ids` against the would-be parent BEFORE the
 * row is written (for atomicity): a rejected edge returns `{ error }` (the
 * whole write is skipped, leaving no partial row create/rename); otherwise it
 * yields the cleaned ids to write once the row exists. The would-be
 * {@link EdgeListing} comes from the parsed input (the *fully merged*
 * ListingInput — `bodyToUpdateInput` folds in the existing defaults, so its
 * fields are the authoritative post-save values) via the shared
 * {@link listingInputToEdge}; on create there is no row yet, so a placeholder id
 * stands in. `null` value when the field is omitted / the parents feature is off
 * (existing edges left intact); a present-but-malformed field is rejected.
 */
export const prepareListingJoins = async (
  input: ListingInput,
  body: Record<string, unknown>,
  existing: ListingWithCount | null,
): Promise<{ error: string } | { value: PreparedListingJoins }> => {
  const groupIds = input.groupIds;
  const submitted = submittedChildIds(body);
  if ("skip" in submitted) {
    return {
      value: { childEdges: null, dayPrices: input.dayPrices, groupIds },
    };
  }
  if ("error" in submitted) return submitted;
  // A listing gaining children becomes a parent; a HIDDEN package's member
  // can't be a parent (the child selector would name the collapsed members),
  // and a package member can't become a child. The group/listing validators
  // only see edges that already exist, so reject the brand-new edges here,
  // before the row + edges commit together.
  const inputGroupIds = input.groupIds === undefined ? [] : input.groupIds;
  const packageConflict = await packageChildEdgeConflict(
    submitted.childIds,
    () => anyHiddenPackageGroup(inputGroupIds),
    () => anyListingInPackageGroup(submitted.childIds),
  );
  if (packageConflict) {
    return { error: packageChildEdgeError(packageConflict) };
  }
  // Resolve add-on reachability against the POST-SAVE listing set: apply the
  // submitted `group_id` to the parent in an in-memory listing set so a parent
  // created/moved into the same group as a child's group-scoped add-on is judged
  // by its would-be group, not the live table that ignores `group_id`.
  // On create the row doesn't exist yet, so the would-be group still applies to
  // the placeholder id (no live group membership to mislead the check).
  const parentId = existing === null ? UNCREATED_PARENT_ID : existing.id;
  const result = await validateChildEdges(
    listingInputToEdge(input, parentId),
    submitted.childIds,
    { wouldBeGroupIds: inputGroupIds },
  );
  return result.ok
    ? {
        value: {
          childEdges: result.childIds,
          dayPrices: input.dayPrices,
          groupIds,
        },
      }
    : { error: result.error };
};

/** Write groups and prices before validating child edges against their current
 * transaction-local state. */
export const persistListingJoins = async (
  tx: TxScope,
  listingId: number,
  value: PreparedListingJoins,
): Promise<void> => {
  if (value.groupIds !== undefined) {
    await setListingGroupsTx(
      tx,
      listingId,
      value.groupIds,
      value.childEdges === null ? undefined : hasChildEdges(value.childEdges),
    );
  }
  await writeListingDayCounts(tx, listingId, value.dayPrices);
  if (value.childEdges !== null) {
    requireListingChildrenPackageCheck(
      await setListingChildrenWithPackageCheckTx(
        tx,
        listingId,
        value.childEdges,
      ),
    );
  }
  await requireTouchingRelationshipsTx(tx, listingId);
};
