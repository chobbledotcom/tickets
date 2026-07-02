/**
 * Validate and apply a catalog transfer blob (see schema.ts), creating one new
 * listing or group with all its facets — group memberships (with package
 * overrides), parent references, and per-day overrides — resolving every
 * cross-reference by name.
 *
 * Every failure path returns an intelligible, field-level message rather than a
 * raw system error: shape errors from the schema, an already-used name, an
 * unresolved/ambiguous reference, or a reused business rule (group type
 * compatibility, package rules, parent-edge compatibility). The write itself is
 * one transaction, so a partial import can never persist.
 */

import * as v from "valibot";
import { mapNotNullish } from "#fp";
import { t } from "#i18n";
import {
  allPackageableMembers,
  generateUniqueGroupSlug,
} from "#routes/admin/groups.ts";
import { writeRowInTransaction } from "#shared/db/client.ts";
import {
  addGroupMembershipTx,
  type GroupInput,
  groupsTable,
  type ImportedMembership,
} from "#shared/db/groups.ts";
import { addParentEdgesTx } from "#shared/db/listing-parents.ts";
import { syncListingPrices } from "#shared/db/listing-prices.ts";
import {
  getListingsById,
  getListingsWithCountsByIds,
  type ListingInput,
  listingsTable,
} from "#shared/db/listings.ts";
import {
  isNameTakenAnywhere,
  loadCatalogNameIndex,
  matchName,
  type NameIndex,
} from "#shared/db/name-registry.ts";
import {
  type EdgeListing,
  edgeFieldError,
} from "#shared/listing-parents-rules.ts";
import {
  generateUniqueListingSlug,
  listingInputToEdge,
  validateListingInput,
} from "#shared/listings-actions.ts";
import {
  type Listing,
  type ListingType,
  normalizeDurationDays,
  parseDayPrices,
} from "#shared/types.ts";
import {
  CatalogTransferSchema,
  formatTransferIssues,
  type GroupTransfer,
  type ListingData,
  type ListingTransfer,
} from "./schema.ts";

/** The result of an import attempt: the created entity's kind/id/name, or an
 * operator-facing error explaining what to fix. */
export type ImportResult =
  | { ok: true; kind: "listing" | "group"; id: number; name: string }
  | { ok: false; error: string };

const fail = (error: string): ImportResult => ({ error, ok: false });

/** Resolve a list of names to ids within one entity kind, returning the ids or
 * the first reference that can't be resolved (missing or, on legacy duplicate
 * data, ambiguous) as an intelligible error. `noun` names the referenced kind
 * in the message. */
const resolveNames = (
  index: NameIndex,
  names: readonly string[],
  noun: string,
): { ids: number[] } | { error: string } => {
  const ids: number[] = [];
  for (const name of names) {
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

/** The uniform "this name is already taken" refusal for both entity kinds. */
const nameTakenError = (name: string): string =>
  `A listing or group named "${name}" already exists — rename or remove it before importing.`;

/** One membership to write once the new row's id is known (the listing-side and
 * group-side imports differ only in which id is fixed). */
type MembershipSpec = Omit<ImportedMembership, "listingId" | "groupId">;

/** Read the shared package-override fields off a membership/member entry. */
const membershipSpec = (entry: {
  packagePrice?: number | null | undefined;
  quantity?: number | undefined;
  dayPrices?: Record<string, number> | undefined;
}): MembershipSpec => ({
  dayPrices: entry.dayPrices ? parseDayPrices(entry.dayPrices) : {},
  packagePrice: entry.packagePrice ?? null,
  quantity: entry.quantity ?? 1,
});

/** Project a validated listing blob onto a `ListingInput`, minting a fresh slug
 * and clearing the (non-transferred) image/attachment columns. Optional fields
 * pass through untouched so the table applies its own column defaults. */
const listingDataToInput = (
  data: ListingData,
  slug: string,
  slugIndex: string,
  groupIds: number[],
): ListingInput => {
  const { closesAt, dayPrices, ...rest } = data;
  // The cast bridges valibot's `T | undefined` optionals to the input's exact
  // optionals — the same shape buildDuplicateListingInput uses for rowToInput.
  return {
    ...rest,
    attachmentName: "",
    attachmentUrl: "",
    closesAt: closesAt ?? undefined,
    dayPrices: dayPrices === undefined ? undefined : parseDayPrices(dayPrices),
    groupIds,
    imageUrl: "",
    slug,
    slugIndex,
  } as ListingInput;
};

/** A listing row projected onto the edge-compatibility shape. */
const listingToEdge = (listing: Listing): EdgeListing => ({
  customisable_days: listing.customisable_days,
  day_prices: listing.day_prices,
  duration_days: normalizeDurationDays(listing.duration_days),
  id: listing.id,
  listing_type: listing.listing_type,
  months_per_unit: listing.months_per_unit,
  name: listing.name,
});

/** Reject a would-be child that can't sit under one of its named parents: a
 * package member is never folded under a parent, and each parent→child edge must
 * satisfy the same field-compatibility rules the edge editor enforces. */
const validateParentEdges = async (
  input: ListingInput,
  parentIds: readonly number[],
): Promise<string | null> => {
  if (parentIds.length === 0) return null;
  for (const groupId of input.groupIds ?? []) {
    const group = await groupsTable.findById(groupId);
    if (group?.is_package) {
      return `"${input.name}" is a member of the package "${group.name}", so it cannot also be an add-on child of another listing.`;
    }
  }
  const childEdge = listingInputToEdge(input, 0);
  const byId = await getListingsById();
  for (const parentId of parentIds) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    const error = edgeFieldError(listingToEdge(parent), childEdge);
    if (error) return error;
  }
  return null;
};

const importListing = async (
  transfer: ListingTransfer,
): Promise<ImportResult> => {
  const { groups: memberships, listing, parents } = transfer;
  if (await isNameTakenAnywhere(listing.name)) {
    return fail(nameTakenError(listing.name));
  }

  const index = await loadCatalogNameIndex();
  const parentResolve = resolveNames(index.listing, parents, "listing");
  if ("error" in parentResolve) return fail(parentResolve.error);
  const groupResolve = resolveNames(
    index.group,
    memberships.map((m) => m.group),
    "group",
  );
  if ("error" in groupResolve) return fail(groupResolve.error);

  const { slug, slugIndex } = await generateUniqueListingSlug();
  const input = listingDataToInput(listing, slug, slugIndex, groupResolve.ids);

  const validationError = await validateListingInput(input);
  if (validationError) return fail(validationError);
  const edgeError = await validateParentEdges(input, parentResolve.ids);
  if (edgeError) return fail(edgeError);

  const specs = memberships.map((m, i) => ({
    ...membershipSpec(m),
    groupId: groupResolve.ids[i]!,
  }));
  const id = await writeRowInTransaction(
    await listingsTable.insertStatement!(input),
    null,
    async (tx, newId) => {
      for (const spec of specs) {
        await addGroupMembershipTx(tx, { ...spec, listingId: newId });
      }
      await addParentEdgesTx(tx, newId, parentResolve.ids);
    },
  );
  // insertStatement bypassed the table wrapper, so re-sync the derived
  // base/day_count price rows from the just-written columns (as afterCommit does).
  await syncListingPrices(id);
  return { id, kind: "listing", name: input.name, ok: true };
};

/** Every listing in a group must share both its type and its customisable-days
 * setting (so the shared booking form shows one selector). Returns the first
 * mismatch as an intelligible error, or null when the members are homogeneous. */
const membersHomogeneous = (
  listings: readonly {
    name: string;
    listing_type: ListingType;
    customisable_days: boolean;
  }[],
): string | null => {
  const [first, ...rest] = listings;
  if (!first) return null;
  const typeMismatch = rest.find((l) => l.listing_type !== first.listing_type);
  if (typeMismatch) {
    return `All listings in a group must be the same type, but "${first.name}" is ${first.listing_type} and "${typeMismatch.name}" is ${typeMismatch.listing_type}.`;
  }
  const customMismatch = rest.find(
    (l) => l.customisable_days !== first.customisable_days,
  );
  if (customMismatch) {
    return `All listings in a group must agree on customisable days, but "${first.name}" and "${customMismatch.name}" differ.`;
  }
  return null;
};

const importGroup = async (transfer: GroupTransfer): Promise<ImportResult> => {
  const { group, members } = transfer;
  if (await isNameTakenAnywhere(group.name)) {
    return fail(nameTakenError(group.name));
  }

  const index = await loadCatalogNameIndex();
  const memberResolve = resolveNames(
    index.listing,
    members.map((m) => m.listing),
    "listing",
  );
  if ("error" in memberResolve) return fail(memberResolve.error);

  const listings = await getListingsWithCountsByIds(memberResolve.ids);
  const byId = new Map(listings.map((l) => [l.id, l]));
  const memberListings = mapNotNullish((id: number) => byId.get(id))(
    memberResolve.ids,
  );

  const homogeneityError = membersHomogeneous(memberListings);
  if (homogeneityError) return fail(homogeneityError);
  if (
    group.isPackage &&
    !(await allPackageableMembers(memberListings, group.hidePackageListings))
  ) {
    return fail(t("error.package_incompatible_listing"));
  }

  const { slug, slugIndex } = await generateUniqueGroupSlug();
  // Cast bridges valibot's `T | undefined` optionals to GroupInput's exact
  // optionals; members are written separately (not via GroupInput.packageMembers).
  const input = { ...group, slug, slugIndex } as GroupInput;
  const specs = members.map((m, i) => ({
    ...membershipSpec(m),
    listingId: memberResolve.ids[i]!,
  }));
  const id = await writeRowInTransaction(
    await groupsTable.insertStatement!(input),
    null,
    async (tx, newId) => {
      for (const spec of specs) {
        await addGroupMembershipTx(tx, { ...spec, groupId: newId });
      }
    },
  );
  return { id, kind: "group", name: input.name, ok: true };
};

/**
 * Parse, validate, and apply a catalog transfer blob. Returns the created
 * entity on success, or an intelligible error describing exactly what to fix.
 * Never throws for bad input — malformed JSON is rejected upstream and every
 * validation failure returns `{ ok: false, error }`.
 */
export const importCatalog = async (blob: unknown): Promise<ImportResult> => {
  const parsed = v.safeParse(CatalogTransferSchema, blob);
  if (!parsed.success) return fail(formatTransferIssues(parsed.issues));
  return parsed.output.kind === "listing"
    ? importListing(parsed.output)
    : importGroup(parsed.output);
};
