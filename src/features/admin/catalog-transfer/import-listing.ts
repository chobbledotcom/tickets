/* jscpd:ignore-start */

import type { BlindIndex } from "#crypto/sealed.ts";
import { settings } from "#db/settings.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import type {
  GroupInput,
  ListingInput,
} from "#shared/catalog-fields/fields.ts";
import { errorResult, type Result } from "#shared/result.ts";
import {
  type AdminLevel,
  availableDayCounts,
  type DayPricedListing,
  type ListingType,
  parseDayPrices,
} from "#types";
import type { ImportedMembership } from "./membership.ts";
import type { GroupData, ListingData } from "./schema.ts";

/* jscpd:ignore-end */

export type ImportedEntity = {
  kind: "listing" | "group";
  id: number;
  name: string;
};

export const fail = (error: string): Result<ImportedEntity> =>
  errorResult(error);

export const importTransactionFailure = (
  error: unknown,
): Result<ImportedEntity> => {
  if (error instanceof TransactionValidationError) return fail(error.message);
  throw error;
};

export const nameTakenError = (name: string): string =>
  `A listing or group named "${name}" already exists — rename or remove it before importing.`;

type MembershipSpec = Omit<ImportedMembership, "listingId" | "groupId"> &
  Partial<Pick<ImportedMembership, "listingId" | "groupId">>;

export const membershipSpec = (
  packagePrice: number | null | undefined,
  quantity: number | undefined,
  dayPrices: Record<string, number> | undefined,
  isPackage: boolean,
): MembershipSpec =>
  isPackage
    ? {
        dayPrices: dayPrices ? parseDayPrices(dayPrices) : {},
        packagePrice: packagePrice ?? null,
        quantity: quantity === undefined ? 1 : quantity,
      }
    : { dayPrices: {}, packagePrice: null, quantity: 1 };

/** The error message for a package member whose day-price override targets a
 *  day count the member does not offer. Null when there is no override or
 *  every override day is valid. */
export const memberDayPriceError = (
  memberName: string,
  dayPrices: Record<string, number>,
  member: DayPricedListing,
): string | null => {
  const offered = new Set(availableDayCounts(member));
  for (const key of Object.keys(dayPrices)) {
    if (!offered.has(Number(key))) {
      return `"${memberName}" does not offer a ${key}-day booking, so it can't carry a package day-price override for it.`;
    }
  }
  return null;
};

/** The listing fields the group-homogeneity rule reads. Shared by the
 * single-group and bundle import paths, which assemble the member rows
 * differently but apply the same rule. */
export const membersHomogeneous = (
  listings: readonly {
    name: string;
    listing_type: ListingType;
    customisable_days: boolean;
  }[],
): string | null => {
  const [first, ...rest] = listings;
  if (!first) return null;
  const typeMismatch = rest.find(
    (listing) => listing.listing_type !== first.listing_type,
  );
  if (typeMismatch) {
    return `All listings in a group must be the same type, but "${first.name}" is ${first.listing_type} and "${typeMismatch.name}" is ${typeMismatch.listing_type}.`;
  }
  const customMismatch = rest.find(
    (listing) => listing.customisable_days !== first.customisable_days,
  );
  return customMismatch
    ? `All listings in a group must agree on customisable days, but "${first.name}" and "${customMismatch.name}" differ.`
    : null;
};

export const listingDataToInput = (
  data: ListingData,
  slug: string,
  slugIndex: string,
  groupIds: number[],
): ListingInput => {
  const {
    bookableDays,
    closesAt,
    dayPrices,
    description,
    location,
    maxAttendees,
    minimumDaysBefore,
    nonTransferable,
    useDefaults,
    usesLogistics,
    ...rest
  } = data;
  return {
    ...rest,
    attachmentName: "",
    attachmentUrl: "",
    bookableDays,
    closesAt: closesAt === null ? undefined : closesAt,
    dayPrices: dayPrices === undefined ? undefined : parseDayPrices(dayPrices),
    description,
    groupIds,
    location,
    maxAttendees,
    minimumDaysBefore,
    nonTransferable,
    slug,
    slugIndex,
    useDefaults,
    usesLogistics,
  } as ListingInput;
};

/** The transferable group columns projected onto the group insert input, the
 * group-side twin of {@link listingDataToInput}. Reads every field by name so
 * the import surfaces exactly what the site stores. */
export const groupDataToInput = (
  data: GroupData,
  slug: string,
  slugIndex: BlindIndex,
): GroupInput => ({
  description: data.description,
  hidden: data.hidden,
  hidePackageListings: data.hidePackageListings,
  isPackage: data.isPackage,
  maxAttendees: data.maxAttendees,
  name: data.name,
  scanChecksInAllListings: data.scanChecksInAllListings,
  showHiddenListings: data.showHiddenListings,
  slug,
  slugIndex,
  termsAndConditions: data.termsAndConditions,
});

export const applyImportPolicy = (
  input: ListingInput,
  adminLevel: AdminLevel | undefined,
): ListingInput => {
  const policed: ListingInput = { ...input };
  if (adminLevel === "editor") {
    policed.webhookUrl = "";
    policed.useDefaults = false;
  }
  if (!settings.features.logistics) policed.usesLogistics = false;
  return policed;
};
