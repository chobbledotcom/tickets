/* jscpd:ignore-start */
import { t } from "#i18n";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { isBuilderEnabled } from "#shared/config.ts";
import {
  TransactionValidationError,
  writeRowInTransaction,
} from "#shared/db/client.ts";
import {
  type ListingGroupMembershipValidation,
  validateListingGroupMembershipsTx,
} from "#shared/db/groups/membership.ts";
import { getGroupsById, groups, listingGroups } from "#shared/db/groups.ts";
import { listingParents } from "#shared/db/listing-parents.ts";
import {
  syncListingPrices,
  writeListingDayCounts,
} from "#shared/db/listing-prices.ts";
import { getListingsById, listingsTable } from "#shared/db/listings/records.ts";
import {
  childOnlyAddOnCheckerForListings,
  type ListingGroupMembership,
  toListingGroupMembership,
} from "#shared/db/modifier-resolve.ts";
import {
  isNameTakenAnywhere,
  loadCatalogNameIndex,
  matchName,
  type NameIndex,
  normalizeEntityName,
} from "#shared/db/name-registry.ts";
import { settings } from "#shared/db/settings.ts";
import {
  childAddOnError,
  type EdgeListing,
  edgeFieldError,
} from "#shared/listing-parents-rules.ts";
import {
  dayPriceFieldsFromInput,
  generateUniqueListingSlug,
  listingInputToEdge,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { packageGroups } from "#shared/package-membership.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { seenBefore } from "#shared/seen-before.ts";
import {
  type AdminLevel,
  availableDayCounts,
  clampDurationDays,
  type DayPricedListing,
  type Group,
  type Listing,
  parseDayPrices,
} from "#shared/types.ts";
import { type ImportedMembership, writeMembershipsTx } from "./membership.ts";
import type { ListingData, ListingTransfer } from "./schema.ts";

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

export const requireImportedMembership = (
  membership: ListingGroupMembershipValidation,
): void => {
  if (membership.listingMissing) {
    throw new TransactionValidationError(t("catalog_transfer.member_missing"));
  }
  if (membership.error) throw new TransactionValidationError(membership.error);
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
  entry: {
    packagePrice?: number | null | undefined;
    quantity?: number | undefined;
    dayPrices?: Record<string, number> | undefined;
  },
  isPackage: boolean,
): MembershipSpec =>
  isPackage
    ? {
        dayPrices: entry.dayPrices ? parseDayPrices(entry.dayPrices) : {},
        packagePrice: entry.packagePrice ?? null,
        quantity: entry.quantity ?? 1,
      }
    : { dayPrices: {}, packagePrice: null, quantity: 1 };

export const memberDayOverrideError = (
  memberName: string,
  dayPrices: Record<string, number> | undefined,
  member: DayPricedListing,
): string | null => {
  if (!dayPrices) return null;
  const offered = new Set(availableDayCounts(member));
  for (const key of Object.keys(dayPrices)) {
    if (!offered.has(Number(key))) {
      return `"${memberName}" does not offer a ${key}-day booking, so it can't carry a package day-price override for it.`;
    }
  }
  return null;
};

const listingDataToInput = (
  data: ListingData,
  slug: string,
  slugIndex: string,
  groupIds: number[],
): ListingInput => {
  const { closesAt, dayPrices, ...rest } = data;
  return {
    ...rest,
    attachmentName: "",
    attachmentUrl: "",
    closesAt: closesAt === null ? undefined : closesAt,
    dayPrices: dayPrices === undefined ? undefined : parseDayPrices(dayPrices),
    groupIds,
    slug,
    slugIndex,
  } as ListingInput;
};

const listingToEdge = (listing: Listing): EdgeListing => ({
  customisable_days: listing.customisable_days,
  day_prices: listing.day_prices,
  duration_days: clampDurationDays(listing.duration_days),
  id: listing.id,
  listing_type: listing.listing_type,
  months_per_unit: listing.months_per_unit,
  name: listing.name,
});

const firstPackageGroup = async (
  groupIds: readonly number[],
): Promise<Group | null> => {
  if (groupIds.length === 0) return null;
  const byId = await getGroupsById();
  return (
    groupIds.map((id) => byId.get(id)).find((group) => group?.is_package) ??
    null
  );
};

const loadChildAddOnChecker = async (
  input: ListingInput,
  groupIds: readonly number[],
  byId: Awaited<ReturnType<typeof getListingsById>>,
): Promise<Awaited<
  ReturnType<typeof childOnlyAddOnCheckerForListings>
> | null> => {
  if (groupIds.length === 0 || input.bookableAlone) return null;
  const allMembership = await listingGroups.getIdsByKeys([...byId.keys()]);
  const wouldBe: ListingGroupMembership[] = [
    ...[...byId.values()].map((listing) =>
      toListingGroupMembership(listing, allMembership),
    ),
    { active: true, groupIds: [...groupIds], id: 0 },
  ];
  return childOnlyAddOnCheckerForListings(wouldBe);
};

type ParentEdges = {
  groupIds: readonly number[];
  input: ListingInput;
  parentIds: readonly number[];
};

const validateParentEdges = async ({
  groupIds,
  input,
  parentIds,
}: ParentEdges): Promise<string | null> => {
  if (parentIds.length === 0) return null;
  const pkg = await firstPackageGroup(groupIds);
  if (pkg) {
    return `"${input.name}" is a member of the package "${pkg.name}", so it cannot also be an add-on child of another listing.`;
  }
  const [byId, nestedParentLinks, parentGroupIds, allGroups] =
    await Promise.all([
      getListingsById(),
      listingParents.getIdsByKeys(parentIds),
      listingGroups.getIdsByKeys([...parentIds]),
      groups.cache.getAll(),
    ]);
  const addOnChecker = await loadChildAddOnChecker(input, groupIds, byId);
  const hiddenPackageIds = new Set(
    allGroups
      .filter((group) => group.is_package && group.hide_package_listings)
      .map((group) => group.id),
  );
  const childEdge = listingInputToEdge(input, 0);
  for (const parentId of parentIds) {
    const parent = byId.get(parentId)!;
    if (nestedParentLinks.get(parentId)!.length > 0) {
      return t("listings_table.children_err_parent_is_child", {
        name: parent.name,
      });
    }
    if (
      listingGroups
        .idsFor(parentGroupIds, parentId)
        .some((groupId) => hiddenPackageIds.has(groupId))
    ) {
      return `"${parent.name}" is a member of a hidden package, so it cannot offer add-on children.`;
    }
    const fieldError = edgeFieldError(listingToEdge(parent), childEdge);
    if (fieldError) return fieldError;
    const addOn = addOnChecker?.(0, [parentId]);
    if (addOn) return childAddOnError(addOn, input.name);
  }
  return null;
};

const applyImportPolicy = (
  input: ListingInput,
  adminLevel: AdminLevel | undefined,
): ListingInput => {
  const policed: ListingInput = { ...input };
  if (adminLevel === "editor") {
    policed.webhookUrl = "";
    policed.useDefaults = false;
  }
  if (!isBuilderEnabled()) {
    policed.assignBuiltSite = false;
    policed.initialSiteMonths = 0;
  }
  if (!settings.features.logistics) policed.usesLogistics = false;
  return policed;
};

export const importListing = async (
  transfer: ListingTransfer,
  adminLevel: AdminLevel | undefined,
): Promise<Result<ImportedEntity>> => {
  const { groups: memberships, listing, parents } = transfer;
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
  const edgeError = await validateParentEdges({
    groupIds: groupResolve.ids,
    input,
    parentIds: parentResolve.ids,
  });
  if (edgeError) return fail(edgeError);

  const packageGroupIds = new Set(
    packageGroups(await groups.cache.getAll()).map((group) => group.id),
  );
  const newMember: DayPricedListing = dayPriceFieldsFromInput(input);
  for (let i = 0; i < memberships.length; i++) {
    if (!packageGroupIds.has(groupResolve.ids[i]!)) continue;
    const dayError = memberDayOverrideError(
      listing.name,
      memberships[i]!.dayPrices,
      newMember,
    );
    if (dayError) return fail(dayError);
  }
  const specs = memberships.map((membership, index) => ({
    ...membershipSpec(
      membership,
      packageGroupIds.has(groupResolve.ids[index]!),
    ),
    groupId: groupResolve.ids[index]!,
  }));
  const id = await writeRowInTransaction(
    await listingsTable.insertStatement!(input),
    null,
    async (tx, newId) => {
      await writeListingDayCounts(tx, newId, input.dayPrices);
      requireImportedMembership(
        await validateListingGroupMembershipsTx(tx)([newId], groupResolve.ids),
      );
      await writeMembershipsTx(tx, withNewId(specs, "listingId", newId));
      await listingParents.addIdsTx(tx, newId, parentResolve.ids);
    },
  );
  await syncListingPrices(id);
  return okResult({ id, kind: "listing", name: input.name });
};
