/* jscpd:ignore-start */

import type { BlindIndex } from "#crypto/sealed.ts";
import { writeRowInTransaction } from "#db/client.ts";
import {
  packageGroupIdsTx,
  requireMembershipValidation,
  validateListingGroupMembershipsTx,
} from "#db/groups/membership.ts";
import { addParentEdgesWithPackageCheckTx } from "#db/listing-parents.ts";
import { syncListingPrices } from "#db/listing-price-sync.ts";
import { writeListingDayCounts } from "#db/listing-prices.ts";
import { listingsTable } from "#db/listings/records.ts";
import {
  isNameTakenAnywhere,
  loadCatalogNameIndex,
  matchName,
  type NameIndex,
  normalizeEntityName,
} from "#db/name-registry.ts";
import { settings } from "#db/settings.ts";
import {
  refuseTheWriteOn,
  TransactionValidationError,
} from "#db/transaction.ts";
import { t } from "#i18n";
import type {
  GroupInput,
  ListingInput,
} from "#shared/catalog-fields/fields.ts";
import { dayPriceFieldsFromInput } from "#shared/listing-edge.ts";
import {
  generateUniqueListingSlug,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { seenBefore } from "#shared/seen-before.ts";
import {
  type AdminLevel,
  availableDayCounts,
  type DayPricedListing,
  type ListingType,
  parseDayPrices,
} from "#types";
import { type ImportedMembership, writeMembershipsTx } from "./membership.ts";
import type { GroupData, ListingData, ListingTransfer } from "./schema.ts";

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

export const resolveNames = (
  index: NameIndex,
  names: readonly string[],
  noun: string,
): { ids: number[] } | { error: string } => {
  const ids: number[] = [];
  const isRepeat = seenBefore();
  for (const name of names) {
    if (isRepeat(normalizeEntityName(name))) {
      return {
        error: `The ${noun} "${name}" is referenced more than once — remove the duplicate.`,
      };
    }
    const match = matchName(index, name);
    if (!match.ok) {
      return {
        error:
          match.reason === "missing"
            ? `No ${noun} named "${name}" exists — it must already exist to import this reference.`
            : `More than one ${noun} is named "${name}"; names must be unique to import by name.`,
      };
    }
    ids.push(match.id);
  }
  return { ids };
};

export const nameTakenError = (name: string): string =>
  `A listing or group named "${name}" already exists — rename or remove it before importing.`;

type MembershipSpec = Omit<ImportedMembership, "listingId" | "groupId"> &
  Partial<Pick<ImportedMembership, "listingId" | "groupId">>;

export const withNewId = (
  specs: readonly MembershipSpec[],
  newIdField: "listingId" | "groupId",
  newId: number,
): ImportedMembership[] =>
  specs.map((spec) => ({ ...spec, [newIdField]: newId }) as ImportedMembership);

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

/** The first id in {@link memberIds} that is absent from {@link found}, or
 *  null when every id was found. Used to detect a member that was deleted
 *  between name resolution and the transaction's SELECT. */
export const missingMemberId = (
  memberIds: readonly number[],
  found: ReadonlyMap<number, unknown>,
): number | null => {
  for (const id of memberIds) {
    if (!found.has(id)) return id;
  }
  return null;
};

/** The day-count key a package member's override targets but the member does
 *  not offer, or null when every override day is valid. Split from
 *  {@link memberDayPriceError} so callers can skip decrypting the member name
 *  until an error is certain. */
export const memberDayOverrideKey = (
  dayPrices: Record<string, number> | undefined,
  member: DayPricedListing,
): string | null => {
  if (!dayPrices) return null;
  const offered = new Set(availableDayCounts(member));
  for (const key of Object.keys(dayPrices)) {
    if (!offered.has(Number(key))) return key;
  }
  return null;
};

/** The error message for a package member whose day-price override targets a
 * day count the member does not offer. Null when the override is valid. */
export const memberDayPriceError = (
  memberName: string,
  ...args: Parameters<typeof memberDayOverrideKey>
): string | null => {
  const key = memberDayOverrideKey(...args);
  return key === null
    ? null
    : `"${memberName}" does not offer a ${key}-day booking, so it can't carry a package day-price override for it.`;
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

export const importListing = async (
  transfer: ListingTransfer,
  adminLevel: AdminLevel | undefined,
): Promise<Result<ImportedEntity>> => {
  const { groups: memberships, listing, parents } = transfer;
  // A built-site plan never imports. Its site assignment is bound to the
  // exporting install. Such a listing can carry no relationships, so the
  // memberships and parent references below must not recreate any.
  if (listing.assignBuiltSite) {
    return fail(
      t("catalog_transfer.site_plan_listing_refused", {
        name: listing.name,
      }),
    );
  }
  if (await isNameTakenAnywhere(listing.name))
    return fail(nameTakenError(listing.name));

  const index = await loadCatalogNameIndex();
  const parentResolve = resolveNames(index.listing, parents, "listing");
  if ("error" in parentResolve) return fail(parentResolve.error);
  const groupResolve = resolveNames(
    index.group,
    memberships.map((membership) => membership.group),
    "group",
  );
  if ("error" in groupResolve) return fail(groupResolve.error);

  const { slug, slugIndex } = await generateUniqueListingSlug();
  const input = applyImportPolicy(
    listingDataToInput(listing, slug, slugIndex, groupResolve.ids),
    adminLevel,
  );
  const validationError = await validateListingInput(input);
  if (validationError) return fail(validationError);

  const newMember: DayPricedListing = dayPriceFieldsFromInput(input);
  const id = await writeRowInTransaction(
    await listingsTable.insertStatement!(input),
    null,
    async (tx, newId) => {
      await writeListingDayCounts(tx, newId, input.dayPrices);
      const packageGroupIds = await packageGroupIdsTx(tx, groupResolve.ids);
      for (const [i, membership] of memberships.entries()) {
        if (!packageGroupIds.has(groupResolve.ids[i]!)) continue;
        const dayError = memberDayPriceError(
          listing.name,
          membership.dayPrices,
          newMember,
        );
        refuseTheWriteOn(dayError);
      }
      await writeMembershipsTx(
        tx,
        withNewId(
          memberships.map((membership, index) => ({
            ...membershipSpec(
              membership.packagePrice,
              membership.quantity,
              membership.dayPrices,
              packageGroupIds.has(groupResolve.ids[index]!),
            ),
            groupId: groupResolve.ids[index]!,
          })),
          "listingId",
          newId,
        ),
      );
      // Validate after the membership insert, so the imported pick count is
      // judged against its own cap as persisted, not against the fresh-join
      // default of one.
      requireMembershipValidation(
        await validateListingGroupMembershipsTx(tx)([newId], groupResolve.ids),
      );
      await addParentEdgesWithPackageCheckTx(
        tx,
        newId,
        parentResolve.ids,
        t("catalog_transfer.parent_missing"),
      );
    },
  );
  await syncListingPrices(id);
  return okResult({ id, kind: "listing", name: input.name });
};
