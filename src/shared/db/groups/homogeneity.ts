/** Checks that every listing in a group shares the same listing type and
 *  customisable-days setting, so a group's members stay interchangeable. */

import { t } from "#i18n";
import { firstReason } from "#shared/reasons.ts";
import type { ListingType } from "#shared/types.ts";

/** The listing fields every group member must share. */
export type GroupListingSettings = {
  id: number;
  listing_type: ListingType;
  customisable_days: boolean;
};

/** Returns the first setting that conflicts with the group's existing members. */
const groupListingTypeError = (
  allSiblings: readonly GroupListingSettings[],
  listingType: ListingType,
  customisableDays: boolean,
  excludeListingId?: number,
): string | null =>
  groupHomogeneityError(
    allSiblings.filter((listing) => listing.id !== excludeListingId),
    listingType,
    customisableDays,
  );

/** Checks one candidate listing against a group's current member settings. */
export const groupListingSettingsError = (
  allSiblings: readonly GroupListingSettings[],
  listing: GroupListingSettings,
  excludeListingId?: number,
): string | null =>
  groupListingTypeError(
    allSiblings,
    listing.listing_type,
    listing.customisable_days,
    excludeListingId,
  );

/** A loaded group paired with the result of checking one listing against it. */
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
    return { error: "Selected group does not exist", group: null, ok: false };
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
    const mismatch = siblings.find(
      (sibling) => sibling.listing_type !== listingType,
    );
    return mismatch
      ? t("error.group_listing_type_mismatch", { type: mismatch.listing_type })
      : null;
  },
  (siblings, _listingType, customisableDays) => {
    const mismatch = siblings.find(
      (sibling) => sibling.customisable_days !== customisableDays,
    );
    return mismatch
      ? mismatch.customisable_days
        ? t("error.group_customisable_days_expected")
        : t("error.group_customisable_days_unexpected")
      : null;
  },
]);
