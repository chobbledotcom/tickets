/* jscpd:ignore-start */
import * as v from "valibot";
import { identity, mapById } from "#fp";
import type { GroupInput } from "#shared/catalog-fields/fields.ts";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  inPlaceholders,
  resultRows,
  type TxScope,
  writeRowInTransaction,
} from "#shared/db/client.ts";
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
  DayPricedListing,
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
  requireDayPriceOk,
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
  memberIds: readonly number[],
  listings: readonly ListingWithCount[],
): Promise<string | null> => {
  const listingById = mapById(identity<ListingWithCount>)(listings);
  const memberListings = memberIds.map((id) => listingById.get(id)!);
  const homogeneityError = membersHomogeneous(memberListings);
  if (homogeneityError) return homogeneityError;
  if (!group.isPackage) return null;
  return packageMembersError(memberListings, group.hidePackageListings);
};

/** Day-price override validation inside the write transaction, so a listing
 *  whose day counts changed between the pre-tx read and this write rolls
 *  back rather than committing an override for a day count it no longer offers.
 *  Reads the member listings through the transaction so the day-count check
 *  sees the current state, not the request-level cache. */
const importedGroupDayPriceErrorTx = async (
  tx: TxScope,
  memberIds: readonly number[],
  members: GroupTransfer["members"],
): Promise<string | null> => {
  const rows = resultRows<
    DayPricedListing & { id: number; name: EnvKeyEncrypted }
  >(
    await tx.execute({
      args: [...memberIds],
      sql: `SELECT listing.id, listing.name, listing.customisable_days,
                   listing.duration_days,
                   COALESCE((
                     SELECT json_group_object(
                       listingPrice.price_id, listingPrice.unit_price)
                       FROM listing_prices AS listingPrice
                      WHERE listingPrice.listing_id = listing.id
                        AND listingPrice.price_type = 'day_count'
                   ), '{}') AS day_prices
              FROM listings AS listing
             WHERE listing.id IN (${inPlaceholders(memberIds)})`,
    }),
  );
  const listingById = mapById(
    identity<DayPricedListing & { id: number; name: EnvKeyEncrypted }>,
  )(rows);
  for (let i = 0; i < members.length; i++) {
    const member = listingById.get(memberIds[i]!)!;
    const dayError = memberDayOverrideError(
      await decrypt(member.name),
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
      if (group.isPackage) {
        const dayError = await importedGroupDayPriceErrorTx(
          tx,
          memberResolve.ids,
          members,
        );
        requireDayPriceOk(dayError);
      }
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
