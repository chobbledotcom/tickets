/* jscpd:ignore-start */
import * as v from "valibot";
import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import {
  inPlaceholders,
  resultRows,
  type TxScope,
  writeRowInTransaction,
} from "#db/client.ts";
import {
  requireMembershipValidation,
  validateListingGroupMembershipsTx,
} from "#db/groups/membership.ts";
import {
  generateUniqueGroupSlug,
  groups,
  packageMembersError,
} from "#db/groups.ts";
import { requireListingsWithCountsByIds } from "#db/listings/records.ts";
import {
  catalogNameLengthError,
  isNameTakenAnywhere,
  loadCatalogNameIndex,
} from "#db/name-registry.ts";
import {
  refuseTheWriteOn,
  TransactionValidationError,
} from "#db/transaction.ts";
import { identity, mapById } from "#fp";
import { t } from "#i18n";
import { sitePlanMemberError } from "#shared/package-membership.ts";
import { okResult, type Result } from "#shared/result.ts";
import {
  type AdminLevel,
  type DayPricedListing,
  type ListingWithCount,
  parseDayPrices,
} from "#types";
import { importBundle } from "./bundle.ts";
import type { ImportedBundle } from "./bundle-plan.ts";
import {
  fail,
  groupDataToInput,
  type ImportedEntity,
  importListing,
  importTransactionFailure,
  memberDayOverrideKey,
  membersHomogeneous,
  membershipSpec,
  missingMemberId,
  nameTakenError,
  resolveNames,
  withNewId,
} from "./import-listing.ts";
import { writeMembershipsTx } from "./membership.ts";
import {
  CatalogTransferSchema,
  formatBundleIssues,
  formatTransferIssues,
  type GroupTransfer,
} from "./schema.ts";

/* jscpd:ignore-end */

const importedGroupMembersError = async (
  group: GroupTransfer["group"],
  memberIds: readonly number[],
  listings: readonly ListingWithCount[],
): Promise<string | null> => {
  const listingById = mapById(identity<ListingWithCount>)(listings);
  const memberListings = memberIds.map((id) => listingById.get(id)!);
  // A built-site plan member joins no group — ordinary or package — so the
  // whole import refuses, as a direct membership write does.
  const sitePlan = memberListings.find((listing) => listing.assign_built_site);
  if (sitePlan) return sitePlanMemberError(sitePlan.name);
  const homogeneityError = membersHomogeneous(memberListings);
  if (homogeneityError) return homogeneityError;
  if (!group.isPackage) return null;
  return packageMembersError(memberListings, group.hidePackageListings);
};

/** Day-price override validation inside the write transaction. A listing
 *  whose day counts changed between the pre-tx read and this write rolls
 *  back. The import then never commits an override for a day count the
 *  listing no longer offers. Reads the member listings through the
 *  transaction so the day-count check sees the current state, not the
 *  request-level cache. */
const importedGroupDayPriceErrorTx = async (
  tx: TxScope,
  memberIds: readonly number[],
  members: GroupTransfer["members"],
): Promise<string | null> => {
  const rows = resultRows<
    Omit<DayPricedListing, "day_prices"> & {
      id: number;
      name: EnvKeyEncrypted;
      day_prices: string;
    }
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
  const listingById = mapById(identity<(typeof rows)[number]>)(rows);
  const missing = missingMemberId(memberIds, listingById);
  if (missing !== null)
    throw new TransactionValidationError(t("catalog_transfer.member_missing"));
  for (let i = 0; i < members.length; i++) {
    const memberId = memberIds[i]!;
    const member = listingById.get(memberId)!;
    const parsedDayPrices = parseDayPrices(member.day_prices);
    const overrideKey = memberDayOverrideKey(members[i]!.dayPrices, {
      ...member,
      day_prices: parsedDayPrices,
    });
    if (overrideKey !== null) {
      return `"${await decrypt(member.name)}" does not offer a ${overrideKey}-day booking, so it can't carry a package day-price override for it.`;
    }
  }
  return null;
};

const importGroup = async (
  transfer: GroupTransfer,
): Promise<Result<ImportedEntity>> => {
  const { group, members } = transfer;
  if (await isNameTakenAnywhere(group.name))
    return fail(nameTakenError(group.name));
  const groupLengthError = catalogNameLengthError(group.name);
  if (groupLengthError) return fail(groupLengthError);

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
  const input = groupDataToInput(group, slug, slugIndex);
  const specs = members.map((member, index) => ({
    ...membershipSpec(
      member.packagePrice,
      member.quantity,
      member.dayPrices,
      group.isPackage ?? false,
    ),
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
        refuseTheWriteOn(dayError);
      }
      await writeMembershipsTx(tx, withNewId(specs, "groupId", newId));
      requireMembershipValidation(
        await validateListingGroupMembershipsTx(tx)(memberResolve.ids, [newId]),
      );
    },
  );
  return okResult({ id, kind: "group", name: input.name });
};

/** Parses, validates, and applies one catalog transfer blob — a single
 * listing, a single group, or a bundle holding many of either. */
export const importCatalog = async (
  blob: unknown,
  adminLevel?: AdminLevel,
): Promise<Result<ImportedEntity | ImportedBundle>> => {
  const parsed = v.safeParse(CatalogTransferSchema, blob);
  if (!parsed.success) {
    const isBundle =
      typeof blob === "object" &&
      blob !== null &&
      "kind" in blob &&
      blob.kind === "bundle";
    return fail(
      isBundle
        ? formatBundleIssues(parsed.issues, blob)
        : formatTransferIssues(parsed.issues),
    );
  }
  try {
    switch (parsed.output.kind) {
      case "listing":
        return await importListing(parsed.output, adminLevel);
      case "group":
        return await importGroup(parsed.output);
      case "bundle":
        return await importBundle(parsed.output, adminLevel);
    }
  } catch (error) {
    return importTransactionFailure(error);
  }
};
