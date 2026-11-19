/** Checks that every listing in a group shares the same listing type and
 *  customisable-days setting, so a group's members stay interchangeable. */

import type { DecodedRowOf } from "#db/select/tables.ts";
import { filter } from "#fp";
import { t } from "#i18n";
import { firstReason } from "#shared/reasons.ts";
import type { ListingType } from "#types";

export type GroupListingSettings = Pick<
  DecodedRowOf<"listings">,
  "customisableDays" | "id" | "listingType"
>;

const groupListingTypeError = (
  allSiblings: readonly GroupListingSettings[],
  listingType: ListingType,
  customisableDays: boolean,
  excludeListingId?: number,
): string | null =>
  groupHomogeneityError(
    filter((listing: GroupListingSettings) => listing.id !== excludeListingId)(
      allSiblings,
    ),
    listingType,
    customisableDays,
  );

export const groupListingSettingsError = (
  allSiblings: readonly GroupListingSettings[],
  listing: GroupListingSettings,
  excludeListingId?: number,
): string | null =>
  groupListingTypeError(
    allSiblings,
    listing.listingType,
    listing.customisableDays,
    excludeListingId,
  );

/** The first member whose setting differs from the one being joined — the one
 *  home of the comparison both the saver and the picker ask. */
const firstMismatchOf =
  (settingOf: (member: GroupListingSettings) => string | boolean) =>
  (
    members: readonly GroupListingSettings[],
    joined: string | boolean,
  ): GroupListingSettings | undefined =>
    members.find((member) => settingOf(member) !== joined);

const typeMismatchOf = firstMismatchOf((member) => member.listingType);

const daysMismatchOf = firstMismatchOf((member) => member.customisableDays);

/**
 * Why a group page must not offer a candidate listing to the operator, or null
 * when it can join. The picker shows the same short why for the two
 * homogeneity rules the saves enforce (same listing type, same
 * customisable-days setting). The affordance and the refusal cannot drift.
 * Pure: the caller supplies the members' settings and the candidate's.
 */
export const groupCandidateBlockedError = (
  members: readonly GroupListingSettings[],
  candidate: GroupListingSettings,
): string | null => {
  const typeMismatch = typeMismatchOf(members, candidate.listingType);
  if (typeMismatch !== undefined) {
    return t("groups.candidate_type_blocked", {
      candidate: candidate.listingType,
      type: typeMismatch.listingType,
    });
  }
  const daysMismatch = daysMismatchOf(members, candidate.customisableDays);
  if (daysMismatch === undefined) return null;
  return candidate.customisableDays
    ? t("groups.candidate_days_blocked_fixed")
    : t("groups.candidate_days_blocked_customisable");
};

export type GroupListingCheck<Group> =
  | { group: Group; ok: true }
  | { error: string; group: null; ok: false };

/** Rejects a missing group or incompatible listing while preserving the loaded group. */
export const checkGroupListingSettings = <Group>(
  group: Group | undefined,
  members: (group: Group) => readonly GroupListingSettings[],
  listing: GroupListingSettings,
  excludeListingId?: number,
): GroupListingCheck<Group> => {
  if (!group) {
    return {
      error: t("error.selected_group_deleted"),
      group: null,
      ok: false,
    };
  }
  const error = groupListingSettingsError(
    members(group),
    listing,
    excludeListingId,
  );
  return error ? { error, group: null, ok: false } : { group, ok: true };
};

const groupHomogeneityError = firstReason<
  [
    siblings: readonly GroupListingSettings[],
    listingType: ListingType,
    customisableDays: boolean,
  ]
>([
  (siblings, listingType) => {
    const mismatch = typeMismatchOf(siblings, listingType);
    return mismatch
      ? t("error.group_listing_type_mismatch", { type: mismatch.listingType })
      : null;
  },
  (siblings, _listingType, customisableDays) => {
    const mismatch = daysMismatchOf(siblings, customisableDays);
    return mismatch
      ? mismatch.customisableDays
        ? t("error.group_customisable_days_expected")
        : t("error.group_customisable_days_unexpected")
      : null;
  },
]);
