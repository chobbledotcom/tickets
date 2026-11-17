import type { BlindIndex } from "#crypto/sealed.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { compact } from "#fp";
import type { GroupInput } from "#shared/records/group-fields.ts";
import type { ListingInput } from "#shared/records/listing-fields.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  availableDayCounts,
  type DayPricedListing,
  type ListingType,
  parseDayPrices,
} from "#types";
import type { ImportedMembership } from "./membership.ts";
import type { GroupData, ListingData } from "./schema.ts";

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

/** The package overrides one membership side declares. */
export type MembershipOverrides = {
  dayPrices?: Record<string, number> | undefined;
  packagePrice?: number | null | undefined;
  quantity?: number | undefined;
};

/** The fields a non-package membership supplies above the neutral value. */
const overrideFieldsSupplied = ({
  dayPrices,
  packagePrice,
  quantity,
}: MembershipOverrides): string[] =>
  compact([
    (packagePrice ?? null) === null ? null : "packagePrice",
    (quantity ?? 1) === 1 ? null : "quantity",
    Object.keys(dayPrices ?? {}).length === 0 ? null : "dayPrices",
  ]);

/** The membership one side declares. A package holds the overrides. A group
 *  that is not a package holds only plain memberships, so its overrides are
 *  refused, not cleared. Clearing them stores a different membership than the
 *  file asked for. */
export const membershipSpec = (
  overrides: MembershipOverrides,
  isPackage: boolean,
): Result<MembershipSpec> => {
  if (isPackage) {
    return okResult({
      dayPrices: overrides.dayPrices ? parseDayPrices(overrides.dayPrices) : {},
      packagePrice: overrides.packagePrice ?? null,
      quantity: overrides.quantity ?? 1,
    });
  }
  const supplied = overrideFieldsSupplied(overrides);
  return supplied.length === 0
    ? okResult({ dayPrices: {}, packagePrice: null, quantity: 1 })
    : errorResult(
        `Only a package group can hold ${supplied.join(", ")}. Remove ${
          supplied.length === 1 ? "it" : "them"
        } or make the group a package.`,
      );
};

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
    listingType: ListingType;
    customisableDays: boolean;
  }[],
): string | null => {
  const [first, ...rest] = listings;
  if (!first) return null;
  const typeMismatch = rest.find(
    (listing) => listing.listingType !== first.listingType,
  );
  if (typeMismatch) {
    return `All listings in a group must be the same type, but "${first.name}" is ${first.listingType} and "${typeMismatch.name}" is ${typeMismatch.listingType}.`;
  }
  const customMismatch = rest.find(
    (listing) => listing.customisableDays !== first.customisableDays,
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
