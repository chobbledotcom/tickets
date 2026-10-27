/**
 * Bundle import entry. Validation reads every fact before the first database
 * write. Then one transaction creates everything. One item or many follow
 * the same path.
 *
 * The write runs in a few statement batches, never one round trip per item.
 * Listings and groups insert first (RETURNING their new ids). Memberships
 * and day prices go next, then parent edges. Any failure rolls the whole
 * import back. Between the batches the write re-runs the single import's
 * guards against the transaction's state. A mid-import edit cannot land an
 * orphan row.
 */

/* jscpd:ignore-start -- imports */
import type { ResultSet } from "@libsql/client";
import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import {
  inPlaceholders,
  resultRows,
  type SqlStatement,
  type TxScope,
  withTransaction,
} from "#db/client.ts";
import {
  requireMembershipValidation,
  validateMembershipPairsTx,
} from "#db/groups/membership.ts";
import { groups } from "#db/groups.ts";
import { guardEdgeWriteTx } from "#db/listing-edge-write.ts";
import { requireListingChildrenPackageCheck } from "#db/listing-parents.ts";
import { syncListingPricesForIds } from "#db/listing-price-sync.ts";
import { dayCountPriceStatements } from "#db/listing-prices.ts";
import { requireCurrentRelationshipRules } from "#db/listing-relationship-validation.ts";
import { listingsTable } from "#db/listings/records.ts";
import { normalizeEntityName as nameKey } from "#db/name-registry.ts";
import { takenSlugIndexes } from "#db/slug-registry.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { unique } from "#fp";
import { t } from "#i18n";
import { requireValue } from "#shared/required-value.ts";
import { generateSlug } from "#shared/slug.ts";
import type { AdminLevel } from "#types";
import {
  type BundleFailure,
  type BundlePlan,
  type BundleRef,
  describeFailure,
  siteGroupIdsOfPairs,
} from "./bundle-plan.ts";
import { siteIdsOfRefs } from "./bundle-refs.ts";
import { type BundleValidation, validateBundle } from "./bundle-validate.ts";
import { groupDataToInput, type ImportedEntity } from "./import-listing.ts";
import { type ImportedMembership, membershipStatements } from "./membership.ts";
import type { CatalogBundle } from "./schema.ts";

/* jscpd:ignore-end */

/** Fresh random slugs for `count` new rows, checked in one batched read.
 * Random collisions (within the batch or with the site) are near-impossible.
 * The retry mirrors the single-import generator's ten attempts. The taken
 * check is a parameter, so the exhaustion path is testable. */
export const freshSlugs = async (
  count: number,
  takenCheck: (
    slugIndexes: readonly string[],
  ) => Promise<Set<string>> = takenSlugIndexes,
): Promise<{ slug: string; slugIndex: BlindIndex }[]> => {
  for (const _attempt of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const slugs = Array.from({ length: count }, () => generateSlug());
    const slugIndexes = await Promise.all(slugs.map((slug) => hmacHash(slug)));
    const taken = await takenCheck(slugIndexes);
    if (taken.size === 0 && new Set(slugIndexes).size === slugIndexes.length) {
      return slugs.map((slug, index) => ({
        slug,
        slugIndex: slugIndexes[index]!,
      }));
    }
  }
  throw new Error("Failed to generate unique slugs for the bundle import");
};

/** Refuse when a row this import links to no longer exists at write time.
 * The link tables carry no foreign key, so a vanished row can become a silent
 * orphan edge or membership. */
export const requireRowsTx = async (
  tx: TxScope,
  table: "listings" | "groups",
  ids: readonly number[],
  messageKey: string,
): Promise<void> => {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return;
  const found = resultRows<{ id: number }>(
    await tx.execute({
      args: wanted,
      sql: `SELECT id FROM ${table} WHERE id IN (${inPlaceholders(wanted)})`,
    }),
  );
  if (found.length !== wanted.length) {
    throw new TransactionValidationError(t(messageKey));
  }
};

/** One multi-row statement for every parent edge the bundle declares. */
const parentEdgeStatement = (
  edges: readonly { childId: number; parentId: number }[],
): SqlStatement | null => {
  const uniqueEdges = [
    ...new Map(
      edges.map((edge) => [`${edge.childId}/${edge.parentId}`, edge] as const),
    ).values(),
  ];
  if (uniqueEdges.length === 0) return null;
  return {
    args: uniqueEdges.flatMap((edge) => [edge.parentId, edge.childId]),
    sql: `INSERT INTO listing_parents (parent_listing_id, child_listing_id) VALUES ${uniqueEdges
      .map(() => "(?, ?)")
      .join(", ")}`,
  };
};

/** The ids an INSERT … RETURNING batch reported, statement by statement. */
const insertedIds = (
  results: readonly ResultSet[],
  from: number,
  to: number,
): number[] =>
  results
    .slice(from, to)
    .map((result) => resultRows<{ id: number }>(result)[0]!.id);

/** Each planned row's new id, keyed by the row's normalised name. */
const plannedIdsOf = <Plan>(
  plans: readonly Plan[],
  ids: readonly number[],
  nameOf: (plan: Plan) => string,
): ReadonlyMap<string, number> =>
  new Map(plans.map((plan, index) => [nameKey(nameOf(plan)), ids[index]!]));

/** Create every planned row in one transaction. Before the edges commit,
 *  re-run the single import's own write guards against the transaction's
 *  state. A row deleted or flipped mid-import rolls the whole import back.
 *  No orphan edge or membership remains. Returns one created entity per
 *  planned row, in plan order. */
const writeBundle = async (
  plan: BundlePlan,
  slugs: readonly { slug: string; slugIndex: BlindIndex }[],
): Promise<ImportedEntity[]> => {
  const { edges, groupPlans, listingPlans, pairs } = plan;
  const listingCount = listingPlans.length;
  return withTransaction(async (tx) => {
    const listingStatements = await Promise.all(
      listingPlans.map((listingPlan, index) =>
        listingsTable.insertStatement!({
          ...listingPlan.input,
          slug: slugs[index]!.slug,
          slugIndex: slugs[index]!.slugIndex,
        }),
      ),
    );
    const groupStatements = await Promise.all(
      groupPlans.map((groupPlan, index) =>
        groups.table.insertStatement!(
          groupDataToInput(
            groupPlan.body.group,
            slugs[listingCount + index]!.slug,
            slugs[listingCount + index]!.slugIndex,
          ),
        ),
      ),
    );
    const results = await tx.batch([...listingStatements, ...groupStatements]);
    const listingIds = insertedIds(results, 0, listingCount);
    const groupIds = insertedIds(results, listingCount, results.length);
    const listingIdByKey = plannedIdsOf(
      listingPlans,
      listingIds,
      (plan) => plan.input.name,
    );
    const groupIdByKey = plannedIdsOf(
      groupPlans,
      groupIds,
      (plan) => plan.body.group.name,
    );
    const idOf = (
      ref: BundleRef,
      idsByKey: ReadonlyMap<string, number>,
      missing: string,
    ): number =>
      "bundleKey" in ref
        ? requireValue(idsByKey.get(ref.bundleKey), missing)
        : ref.siteId;
    const listingIdOf = (ref: BundleRef): number =>
      idOf(ref, listingIdByKey, "Planned listing id missing");
    const groupIdOf = (ref: BundleRef): number =>
      idOf(ref, groupIdByKey, "Planned group id missing");
    const memberships: ImportedMembership[] = pairs.map((pair) => ({
      ...pair.spec,
      groupId: groupIdOf(pair.group),
      listingId: listingIdOf(pair.listing),
    }));
    const edgeRows: { childId: number; parentId: number }[] = [];
    for (const edge of edges) {
      edgeRows.push({
        childId: listingIdOf(edge.child),
        parentId: listingIdOf(edge.parent),
      });
    }
    // The rows the memberships and edges link to must still exist. `listing_
    // parents` and `group_listings` carry no foreign key, so a vanished row
    // becomes a silent orphan edge or membership.
    await requireRowsTx(
      tx,
      "listings",
      unique(siteIdsOfRefs(edges.map((edge) => edge.parent))),
      "catalog_transfer.parent_missing",
    );
    await requireRowsTx(
      tx,
      "groups",
      siteGroupIdsOfPairs(pairs),
      "catalog_transfer.group_missing",
    );
    await tx.batch([
      ...listingPlans.flatMap((listingPlan, index) =>
        dayCountPriceStatements(
          listingIds[index]!,
          listingPlan.input.dayPrices,
        ),
      ),
      ...membershipStatements(memberships),
    ]);
    // The memberships must hold against the transaction's own state. A member
    // deleted, turned into a built-site plan, or flipped to another type after
    // the document was read rolls the whole import back. This is the same
    // recheck the single-item write runs, over exactly the pairs this import
    // creates.
    requireMembershipValidation(
      await validateMembershipPairsTx(tx)(
        memberships.map(({ groupId, listingId }) => ({ groupId, listingId })),
      ),
    );
    // Each child's edges re-run the edge write's own guards against the
    // transaction's state: parent existence, nesting, and the package
    // conflicts. The field and add-on reachability rules then run once for
    // every edge together.
    const parentIdsByChild = new Map<number, number[]>();
    for (const edge of edgeRows) {
      const parents = parentIdsByChild.get(edge.childId) ?? [];
      parents.push(edge.parentId);
      parentIdsByChild.set(edge.childId, parents);
    }
    for (const [childId, parentIds] of parentIdsByChild) {
      requireListingChildrenPackageCheck(
        await guardEdgeWriteTx({
          childIds: [childId],
          contract: "parents",
          missingParentError: t("catalog_transfer.parent_missing"),
          parentIds,
          tx,
        }),
      );
    }
    // The field rules and the add-on reachability run once for every edge
    // together, against the transaction's state. The await matters: an
    // unawaited refusal can throw after this transaction commits.
    await requireCurrentRelationshipRules(tx, edgeRows);
    const edgeStatement = parentEdgeStatement(edgeRows);
    if (edgeStatement !== null) await tx.execute(edgeStatement);
    await syncListingPricesForIds(listingIds, tx);
    return [
      ...listingPlans.map((listingPlan, index) => ({
        id: listingIds[index]!,
        kind: "listing" as const,
        name: listingPlan.input.name,
      })),
      ...groupPlans.map((groupPlan, index) => ({
        id: groupIds[index]!,
        kind: "group" as const,
        name: groupPlan.body.group.name,
      })),
    ];
  });
};

/** What one import attempt answers: every created item in plan order, or
 *  the validation's own failing items with their reasons. The caller formats
 *  the failures and picks the result shape, so one listing and an array of
 *  listings run this same path end to end. */
export type BundleOutcome =
  | { created: ImportedEntity[]; ok: true }
  | Exclude<BundleValidation, { ok: true }>;

/** The operator-facing message for a bundle that failed validation: every
 *  failing item, named, with each of its reasons. */
export const formatBundleFailures = (
  failures: readonly BundleFailure[],
): string =>
  `${t("catalog_transfer.bundle_failed")} ${failures
    .map(describeFailure)
    .join("; ")}`;

/** Validates and writes a shape-validated bundle document — one listing, one
 *  group, or many of either: every failing item and nothing, or every created
 *  item. */
export const importBundleItems = async (
  bundle: CatalogBundle,
  adminLevel: AdminLevel | undefined,
): Promise<BundleOutcome> => {
  const validation = await validateBundle(bundle, adminLevel);
  if (!validation.ok) return validation;
  const { plan } = validation;
  const slugs = await freshSlugs(
    plan.listingPlans.length + plan.groupPlans.length,
  );
  return { created: await writeBundle(plan, slugs), ok: true };
};
