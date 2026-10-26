/**
 * Bundle import entry. Validation reads every fact before the first database
 * write. Then one transaction creates everything.
 *
 * The write uses a few statement batches, never one round trip per item. One
 * batch inserts the listings and groups. Each insert reports its new id
 * through RETURNING. A second batch writes the memberships, day prices, and
 * parent edges. A third syncs the price mirror. A 60-listing bundle costs
 * single-digit round trips, and any failure rolls the whole import back.
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
import { groups } from "#db/groups.ts";
import { syncListingPricesForIds } from "#db/listing-price-sync.ts";
import { dayCountPriceStatements } from "#db/listing-prices.ts";
import { listingsTable } from "#db/listings/records.ts";
import { normalizeEntityName as nameKey } from "#db/name-registry.ts";
import { takenSlugIndexes } from "#db/slug-registry.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { unique } from "#fp";
import { t } from "#i18n";
import { requireValue } from "#shared/required-value.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { generateSlug } from "#shared/slug.ts";
import type { AdminLevel } from "#types";
import {
  type BundlePlan,
  type BundleRef,
  describeFailure,
  type ImportedBundle,
} from "./bundle-plan.ts";
import { validateBundle } from "./bundle-validate.ts";
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

/** The rows this import links to that already exist on the site. */
type SiteEntityRefs = {
  groupIds: readonly number[];
  listingIds: readonly number[];
};

/** Refuse when a row this import links to no longer exists at write time.
 * The link tables carry no foreign key, so a vanished row can become a silent
 * orphan edge or membership. */
const requireSiteEntitiesTx = async (
  tx: TxScope,
  refs: SiteEntityRefs,
): Promise<void> => {
  await requireRowsTx(
    tx,
    "listings",
    refs.listingIds,
    "catalog_transfer.parent_missing",
  );
  await requireRowsTx(
    tx,
    "groups",
    refs.groupIds,
    "catalog_transfer.group_missing",
  );
};

/** Throw when any id holds no row in `table`, with the given refusal. A
 * vanished row can then become a silent orphan edge or membership. */
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

/** Create every planned row in one transaction. */
const writeBundle = async (
  plan: BundlePlan,
  slugs: readonly { slug: string; slugIndex: BlindIndex }[],
): Promise<void> => {
  const { edges, groupPlans, listingPlans, pairs } = plan;
  const listingCount = listingPlans.length;
  await withTransaction(async (tx) => {
    const siteListingIds = unique(
      [
        ...pairs.map((pair) => pair.listing),
        ...edges.map((edge) => edge.parent),
      ].flatMap((ref) => ("siteId" in ref ? [ref.siteId] : [])),
    );
    const siteGroupIds = unique(
      pairs.flatMap((pair) =>
        "siteId" in pair.group ? [pair.group.siteId] : [],
      ),
    );
    await requireSiteEntitiesTx(tx, {
      groupIds: siteGroupIds,
      listingIds: siteListingIds,
    });
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
        groups.table.insertStatement!({
          ...groupPlan.body.group,
          slug: slugs[listingCount + index]!.slug,
          slugIndex: slugs[listingCount + index]!.slugIndex,
        }),
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
    const edgeStatement = parentEdgeStatement(edgeRows);
    await tx.batch([
      ...listingPlans.flatMap((listingPlan, index) =>
        dayCountPriceStatements(
          listingIds[index]!,
          listingPlan.input.dayPrices,
        ),
      ),
      ...membershipStatements(memberships),
      ...(edgeStatement === null ? [] : [edgeStatement]),
    ]);
    await syncListingPricesForIds(listingIds, tx);
  });
};

/** Creates every item of an already shape-validated bundle document, or
 * reports every failing item and creates nothing. */
export const importBundle = async (
  bundle: CatalogBundle,
  adminLevel: AdminLevel | undefined,
): Promise<Result<ImportedBundle>> => {
  const validation = await validateBundle(bundle, adminLevel);
  if (!validation.ok) {
    return errorResult(
      `${t("catalog_transfer.bundle_failed")} ${validation.failures
        .map(describeFailure)
        .join("; ")}`,
    );
  }
  const { plan } = validation;
  const slugs = await freshSlugs(
    plan.listingPlans.length + plan.groupPlans.length,
  );
  await writeBundle(plan, slugs);
  return okResult({
    groups: plan.groupPlans.length,
    kind: "bundle",
    listings: plan.listingPlans.length,
  });
};
