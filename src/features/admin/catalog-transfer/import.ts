/* jscpd:ignore-start */
import * as v from "valibot";
import { identity, mapById } from "#fp";
import type { GroupInput } from "#shared/catalog-fields/fields.ts";
import { writeRowInTransaction } from "#shared/db/client.ts";
import { validateListingGroupMembershipsTx } from "#shared/db/groups/membership.ts";
import {
  generateUniqueGroupSlug,
  groups,
  packageMembersError,
} from "#shared/db/groups.ts";
import { requireListingsWithCountsByIds } from "#shared/db/listings/records.ts";
import {
  isNameTakenAnywhere,
  loadCatalogNameIndex,
} from "#shared/db/name-registry.ts";
import { okResult, type Result } from "#shared/result.ts";
import type {
  AdminLevel,
  ListingType,
  ListingWithCount,
} from "#shared/types.ts";
import {
  fail,
  type ImportedEntity,
  importListing,
  importTransactionFailure,
  memberDayOverrideError,
  membershipSpec,
  nameTakenError,
  requireImportedMembership,
  resolveNames,
  withNewId,
} from "./import-listing.ts";
import { writeMembershipsTx } from "./membership.ts";
import {
  CatalogTransferSchema,
  formatTransferIssues,
  type GroupTransfer,
} from "./schema.ts";

/* jscpd:ignore-end */

const membersHomogeneous = (
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

const importedGroupMembersError = async (
  group: GroupTransfer["group"],
  members: GroupTransfer["members"],
  memberIds: readonly number[],
  listings: readonly ListingWithCount[],
): Promise<string | null> => {
  const listingById = mapById(identity<ListingWithCount>)(listings);
  const memberListings = memberIds.map((id) => listingById.get(id)!);
  const homogeneityError = membersHomogeneous(memberListings);
  if (homogeneityError) return homogeneityError;
  if (!group.isPackage) return null;
  const packageError = await packageMembersError(
    memberListings,
    group.hidePackageListings,
  );
  if (packageError) return packageError;
  for (let i = 0; i < members.length; i++) {
    const member = listingById.get(memberIds[i]!)!;
    const dayError = memberDayOverrideError(
      member.name,
      members[i]!.dayPrices,
      member,
    );
    if (dayError) return dayError;
  }
  return null;
};

const importGroup = async (
  transfer: GroupTransfer,
): Promise<Result<ImportedEntity>> => {
  const { group, members } = transfer;
  if (await isNameTakenAnywhere(group.name))
    return fail(nameTakenError(group.name));

  const index = await loadCatalogNameIndex();
  const memberResolve = resolveNames(
    index.listing,
    members.map((member) => member.listing),
    "listing",
  );
  if ("error" in memberResolve) return fail(memberResolve.error);

  const listings = await requireListingsWithCountsByIds(memberResolve.ids);
  const memberError = await importedGroupMembersError(
    group,
    members,
    memberResolve.ids,
    listings,
  );
  if (memberError) return fail(memberError);

  const { slug, slugIndex } = await generateUniqueGroupSlug();
  const input: GroupInput = { ...group, slug, slugIndex };
  const specs = members.map((member, index) => ({
    ...membershipSpec(member, group.isPackage ?? false),
    listingId: memberResolve.ids[index]!,
  }));
  const id = await writeRowInTransaction(
    await groups.table.insertStatement!(input),
    null,
    async (tx, newId) => {
      await writeMembershipsTx(tx, withNewId(specs, "groupId", newId));
      requireImportedMembership(
        await validateListingGroupMembershipsTx(tx)(memberResolve.ids, [newId]),
      );
    },
  );
  return okResult({ id, kind: "group", name: input.name });
};

/** Parses, validates, and applies one catalog transfer blob. */
export const importCatalog = async (
  blob: unknown,
  adminLevel?: AdminLevel,
): Promise<Result<ImportedEntity>> => {
  const parsed = v.safeParse(CatalogTransferSchema, blob);
  if (!parsed.success) return fail(formatTransferIssues(parsed.issues));
  try {
    return parsed.output.kind === "listing"
      ? await importListing(parsed.output, adminLevel)
      : await importGroup(parsed.output);
  } catch (error) {
    return importTransactionFailure(error);
  }
};
