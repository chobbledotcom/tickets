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
import { identity, mapById, mapNotNullish } from "#fp";
import { t } from "#i18n";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { generateUniqueGroupSlug } from "#routes/admin/groups.ts";
import { writeRowInTransaction } from "#shared/db/client.ts";
import {
  type GroupInput,
  getGroupsById,
  groups,
  listingGroups,
  packageMembersError,
} from "#shared/db/groups.ts";
import { listingParents } from "#shared/db/listing-parents.ts";
import {
  syncListingPrices,
  writeListingDayCounts,
} from "#shared/db/listing-prices.ts";
import {
  getListingsById,
  getListingsWithCountsByIds,
  listingsTable,
} from "#shared/db/listings/records.ts";
import type { ListingInput } from "#shared/db/listings/table.ts";
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
  type EdgeListing,
  edgeFieldError,
} from "#shared/listing-parents-rules.ts";
import {
  dayPriceFieldsFromInput,
  generateUniqueListingSlug,
  listingInputToEdge,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { seenBefore } from "#shared/seen-before.ts";
import {
  type AdminLevel,
  availableDayCounts,
  clampDurationDays,
  type DayPricedListing,
  type Group,
  type Listing,
  type ListingType,
  type ListingWithCount,
  parseDayPrices,
} from "#shared/types.ts";
import { childAddOnError } from "../listings-parents.ts";
import { type ImportedMembership, writeMembershipsTx } from "./membership.ts";
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
  const isRepeat = seenBefore();
  for (const name of names) {
    // A repeated reference would insert a duplicate edge/membership row and trip
    // a unique index (a raw 500); reject it with an intelligible message first.
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

/** The uniform "this name is already taken" refusal for both entity kinds. */
const nameTakenError = (name: string): string =>
  `A listing or group named "${name}" already exists — rename or remove it before importing.`;

/** One membership to write once the new row's id is known — carries the peer id
 * (the group for a listing import, the listing for a group import); the new
 * row's own id fills the other side. */
type MembershipSpec = Omit<ImportedMembership, "listingId" | "groupId"> &
  Partial<Pick<ImportedMembership, "listingId" | "groupId">>;

/** Fill the freshly-created row's id into whichever side (`listingId` for a
 * listing import, `groupId` for a group import) the specs left open, ready for
 * {@link writeMembershipsTx}. */
const withNewId = (
  specs: readonly MembershipSpec[],
  newIdField: "listingId" | "groupId",
  newId: number,
): ImportedMembership[] =>
  specs.map((spec) => ({ ...spec, [newIdField]: newId }) as ImportedMembership);

/** The first of `groupIds` that names a package group, or null — the "is this
 * listing a package member?" check the parent-edge guard needs. */
const firstPackageGroup = async (
  groupIds: readonly number[],
): Promise<Group | null> => {
  if (groupIds.length === 0) return null;
  // Resolve against the cached group set rather than one findById per group, so a
  // child listing that belongs to many groups doesn't trip the request N+1 guard.
  const byId = await getGroupsById();
  for (const groupId of groupIds) {
    const group = byId.get(groupId);
    if (group?.is_package) return group;
  }
  return null;
};

/** Read the shared package-override fields off a membership/member entry.
 * `isPackage` false clears every override (price/quantity/day prices) — those
 * only apply to a package group, and the normal group save drops them when a
 * group isn't a package, so a blob can't plant a hidden free price or quantity
 * that silently activates if the group is later converted. */
const membershipSpec = (
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

/** Reject a package day-price override for a day count the member doesn't offer.
 * The package editor only renders override inputs for a member's available day
 * counts (a customisable listing's priced spans within its duration); a blob
 * override outside them would be a hidden `group_day` row that could activate
 * after a later duration/day-price edit, so refuse it with a field-level
 * message. `member` is the listing whose spans the override must fit — the
 * existing member on a group import, the new listing itself on a listing
 * import. */
const memberDayOverrideError = (
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

/** Project a validated listing blob onto a `ListingInput`, minting a fresh slug
 * and clearing the non-transferred attachment columns. Optional fields
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
    closesAt: closesAt === null ? undefined : closesAt,
    dayPrices: dayPrices === undefined ? undefined : parseDayPrices(dayPrices),
    groupIds,
    slug,
    slugIndex,
  } as ListingInput;
};

/** A listing row projected onto the edge-compatibility shape. */
const listingToEdge = (listing: Listing): EdgeListing => ({
  customisable_days: listing.customisable_days,
  day_prices: listing.day_prices,
  duration_days: clampDurationDays(listing.duration_days),
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
  groupIds: readonly number[],
): Promise<string | null> => {
  if (parentIds.length === 0) return null;
  const pkg = await firstPackageGroup(groupIds);
  if (pkg) {
    return `"${input.name}" is a member of the package "${pkg.name}", so it cannot also be an add-on child of another listing.`;
  }
  const childEdge = listingInputToEdge(input, 0);
  // Batched reads (never one query per parent, so a many-parent import can't
  // trip the request's N+1 guard): the listing rows, the parents that are
  // themselves children, each parent's group ids, and the whole (cached) group
  // set to identify hidden packages.
  const [byId, nestedParentLinks, parentGroupIds, allGroups] =
    await Promise.all([
      getListingsById(),
      listingParents.getIdsByKeys(parentIds),
      listingGroups.getIdsByKeys([...parentIds]),
      groups.cache.getAll(),
    ]);
  const hiddenPackageIds = new Set(
    allGroups
      .filter((g) => g.is_package && g.hide_package_listings)
      .map((g) => g.id),
  );
  // A child that joins a group can inherit a group-scoped opt-in add-on. If that
  // add-on's would-be scope reaches only this (suppressed) child and not the
  // parent's page, the add-on becomes unbookable — the same dead-end the edge
  // editor rejects. Resolve every add-on's would-be scope once (the new child
  // appended at placeholder id 0 with its would-be groups) and reuse it per
  // parent. A child with no groups can't inherit such an add-on, so skip the work.
  // A `bookable_alone` child keeps its OWN booking page, so its add-on is still
  // reachable there — the edge editor exempts it (`if (bookable_alone) continue`),
  // so skip the check here too rather than reject a valid exported child.
  let addOnChecker:
    | ((childId: number, pageIds: readonly number[]) => string | null)
    | null = null;
  if (groupIds.length > 0 && !input.bookableAlone) {
    const allMembership = await listingGroups.getIdsByKeys([...byId.keys()]);
    const wouldBe: ListingGroupMembership[] = [
      ...[...byId.values()].map((l) =>
        toListingGroupMembership(l, allMembership),
      ),
      // active is irrelevant to child-reachability (only the deactivation check
      // reads it); the placeholder child serves a page as far as this check cares.
      { active: true, groupIds: [...groupIds], id: 0 },
    ];
    addOnChecker = await childOnlyAddOnCheckerForListings(wouldBe);
  }
  for (const parentId of parentIds) {
    // parentIds were resolved by name from the same cached catalog byId reads,
    // so every id is present (trust the invariant rather than guard a dead path).
    const parent = byId.get(parentId)!;
    // Single-level nesting only: a parent that is itself a child of another
    // listing can't gain a child (the edge editor rejects the same shape).
    if (nestedParentLinks.get(parentId)!.length > 0) {
      return t("listings_table.children_err_parent_is_child", {
        name: parent.name,
      });
    }
    // A hidden-package member is collapsed on buyer surfaces and can't render a
    // child selector, so it may not gain children — the same rule the edge
    // editor enforces via packageChildEdgeConflict.
    if (
      listingGroups
        .idsFor(parentGroupIds, parentId)
        .some((groupId) => hiddenPackageIds.has(groupId))
    ) {
      return `"${parent.name}" is a member of a hidden package, so it cannot offer add-on children.`;
    }
    const error = edgeFieldError(listingToEdge(parent), childEdge);
    if (error) return error;
    // The would-be child (id 0) must not carry an opt-in add-on reachable only
    // through itself from this parent's page — mirroring the edge editor.
    const addOn = addOnChecker?.(0, [parentId]);
    if (addOn) return childAddOnError(addOn, input.name);
  }
  return null;
};

/** Apply role/site policy the interactive create paths enforce but a raw blob
 * bypasses: an `editor` may not set a webhook URL (it receives attendee PII) or
 * toggle `use_defaults`; a listing can only assign a built site where the
 * builder is configured; and logistics can only be required where logistics is
 * enabled (the form forces `uses_logistics` off otherwise). */
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
  if (!settings.features.logistics) {
    policed.usesLogistics = false;
  }
  return policed;
};

const importListing = async (
  transfer: ListingTransfer,
  adminLevel: AdminLevel | undefined,
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
  const input = applyImportPolicy(
    listingDataToInput(listing, slug, slugIndex, groupResolve.ids),
    adminLevel,
  );

  const validationError = await validateListingInput(input);
  if (validationError) return fail(validationError);
  const edgeError = await validateParentEdges(
    input,
    parentResolve.ids,
    groupResolve.ids,
  );
  if (edgeError) return fail(edgeError);

  // Package overrides only apply to a package group; clear them for any regular
  // group the listing joins (matching the normal group save).
  const packageGroupIds = new Set(
    (await groups.cache.getAll()).filter((g) => g.is_package).map((g) => g.id),
  );
  // A package day-price override must target a day count this listing offers —
  // the new listing itself is the member here, so validate against its own spans.
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
  const specs = memberships.map((m, i) => {
    const groupId = groupResolve.ids[i]!;
    return {
      ...membershipSpec(m, packageGroupIds.has(groupId)),
      groupId,
    };
  });
  const id = await writeRowInTransaction(
    await listingsTable.insertStatement!(input),
    null,
    async (tx, newId) => {
      // insertStatement bypasses the listingsTable wrapper, which normally writes
      // the listing's own `day_count` price rows (their source of truth is
      // listing_prices, not a column). Write them here so an imported customisable
      // listing keeps its per-day prices, committed atomically with the row.
      await writeListingDayCounts(tx, newId, input.dayPrices);
      await writeMembershipsTx(tx, withNewId(specs, "listingId", newId));
      await listingParents.addIdsTx(tx, newId, parentResolve.ids);
    },
  );
  // insertStatement bypassed the table wrapper, so re-sync the derived `base`
  // price row from the just-written `unit_price` column (as afterCommit does).
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
  // Members are few, so resolve each id against the loaded set directly (order
  // preserved, missing dropped) rather than building an intermediate index.
  const memberListings = mapNotNullish((id: number) =>
    listings.find((l) => l.id === id),
  )(memberResolve.ids);

  const homogeneityError = membersHomogeneous(memberListings);
  if (homogeneityError) return fail(homogeneityError);
  if (group.isPackage) {
    const packageError = await packageMembersError(
      memberListings,
      group.hidePackageListings,
    );
    if (packageError) return fail(packageError);
  }

  const { slug, slugIndex } = await generateUniqueGroupSlug();
  // Cast bridges valibot's `T | undefined` optionals to GroupInput's exact
  // optionals; members are written separately (not via GroupInput.packageMembers).
  const input = { ...group, slug, slugIndex } as GroupInput;
  // Package overrides only apply to a package group; a non-package group clears
  // them (matching the normal group save).
  const isPackage = group.isPackage ?? false;
  // Each member's day-price overrides must target a day count that member offers.
  if (isPackage) {
    const listingById = mapById(identity<ListingWithCount>)(listings);
    for (let i = 0; i < members.length; i++) {
      const member = listingById.get(memberResolve.ids[i]!)!;
      const dayError = memberDayOverrideError(
        member.name,
        members[i]!.dayPrices,
        member,
      );
      if (dayError) return fail(dayError);
    }
  }
  const specs = members.map((m, i) => ({
    ...membershipSpec(m, isPackage),
    listingId: memberResolve.ids[i]!,
  }));
  const id = await writeRowInTransaction(
    await groups.table.insertStatement!(input),
    null,
    (tx, newId) => writeMembershipsTx(tx, withNewId(specs, "groupId", newId)),
  );
  return { id, kind: "group", name: input.name, ok: true };
};

/**
 * Parse, validate, and apply a catalog transfer blob. Returns the created
 * entity on success, or an intelligible error describing exactly what to fix.
 * Never throws for bad input — malformed JSON is rejected upstream and every
 * validation failure returns `{ ok: false, error }`. `adminLevel` is the
 * importing user's role, so the same field locks the interactive create paths
 * enforce for editors are applied to an uploaded listing.
 */
export const importCatalog = async (
  blob: unknown,
  adminLevel?: AdminLevel,
): Promise<ImportResult> => {
  const parsed = v.safeParse(CatalogTransferSchema, blob);
  if (!parsed.success) return fail(formatTransferIssues(parsed.issues));
  return parsed.output.kind === "listing"
    ? importListing(parsed.output, adminLevel)
    : importGroup(parsed.output);
};
