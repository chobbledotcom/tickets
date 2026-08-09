/**
 * The shared transaction-local guard behind both parent/child edge writers.
 *
 * `setListingChildrenWithPackageCheckTx` and `addParentEdgesWithPackageCheckTx`
 * used to hand-roll the same partial check — a SELECT of existence / nesting /
 * package EXISTS flags — independently, so the two could drift. This module
 * folds those checks into ONE declaration: the caller states which ids fill the
 * PARENT role and which the CHILD role (the writers differ only in which side
 * is the single fixed listing and which the submitted set), and the guard
 * throws `TransactionValidationError` if any current-tx state violates a rule,
 * returning the package conflict for the caller to convert as its contract.
 *
 * This is deliberately the schema-tized version of the "revalidate in-tx"
 * concern: a single declared check list, not a per-writer hand-rolled SELECT.
 * The edge-field and child-only-add-on rules are the natural next entries in
 * the check list, layered on a transaction-local read of the endpoints.
 */

import { t } from "#i18n";
import { inPlaceholders, resultRows, type TxScope } from "#shared/db/client.ts";
import { TransactionValidationError } from "#shared/db/transaction.ts";
import {
  type PackageChildEdgeBlock,
  packageChildEdgeConflict,
} from "#shared/package-membership.ts";

/** How the guard surfaces a package conflict: the children writer returns it,
 *  the parent writer throws it (after this module reports it). */
export type EdgeWriteContract = "children" | "parents";

/** One edge-write guard: the two role id sets plus how the caller converts a
 *  package conflict. */
export type GuardEdgeWriteInput = {
  tx: TxScope;
  /** The ids on the PARENT side: the parent itself (children) or the submitted
   *  parents (parents). */
  parentIds: readonly number[];
  /** The ids on the CHILD side: the submitted children (children) or the child
   *  itself (parents). */
  childIds: readonly number[];
  /** The error when a parent-side listing no longer exists (the parents
   *  contract supplies the catalog-import-specific message). */
  missingParentError: string;
  /** Which writer this backs — decides the missing-existence message and the
   *  nesting-check precedence. */
  contract: EdgeWriteContract;
};

type EdgeState = {
  child_count: number;
  child_has_children: number;
  child_is_package_member: number;
  parent_count: number;
  parent_has_parent: number;
  parent_is_hidden_package_member: number;
};

const nestingError = (
  contract: EdgeWriteContract,
  hasParent: number,
  hasChildren: number,
  hasEdges: boolean,
): string | null => {
  if (contract === "children") {
    if (hasEdges && hasParent) {
      return t("error.parent_listing_nested");
    }
    if (hasChildren) return t("error.child_listing_nested");
    return null;
  }
  if (hasChildren) return t("error.child_listing_nested");
  if (hasParent) return t("error.parent_listing_nested");
  return null;
};

const requireExists = (
  count: number,
  expected: number,
  message: string,
): void => {
  if (count !== expected) throw new TransactionValidationError(message);
};

/** The edge-state checks shared by both writers, in one SELECT. `parentIds`/`
 *  `childIds` are the role id sets; each `IN` clause is filled by its own bound
 *  args so the query never builds an empty `IN ()`. */
export const guardEdgeWriteTx = async (
  input: GuardEdgeWriteInput,
): Promise<PackageChildEdgeBlock | null> => {
  const { tx, parentIds, childIds, missingParentError, contract } = input;
  const parentSet = new Set(parentIds);
  const childSet = new Set(childIds);
  const uniqueParentIds = [...parentSet];
  const uniqueChildIds = [...childSet];

  const [state] = resultRows<EdgeState>(
    await tx.execute({
      args: [
        ...uniqueChildIds,
        ...uniqueParentIds,
        ...uniqueChildIds,
        ...uniqueParentIds,
        ...uniqueParentIds,
        ...uniqueChildIds,
      ],
      sql: `SELECT EXISTS(
                      SELECT 1
                        FROM group_listings AS childMembership
                        JOIN groups AS childGroup
                          ON childGroup.id = childMembership.group_id
                       WHERE childMembership.listing_id IN (${inPlaceholders(uniqueChildIds)})
                         AND childGroup.is_package = 1
                    ) AS child_is_package_member,
                    EXISTS(
                      SELECT 1
                        FROM group_listings AS parentMembership
                        JOIN groups AS parentGroup
                          ON parentGroup.id = parentMembership.group_id
                       WHERE parentMembership.listing_id IN (${inPlaceholders(uniqueParentIds)})
                         AND parentGroup.is_package = 1
                         AND parentGroup.hide_package_listings = 1
                    ) AS parent_is_hidden_package_member,
                    (SELECT COUNT(*) FROM listings
                       WHERE id IN (${inPlaceholders(uniqueChildIds)})) AS child_count,
                    (SELECT COUNT(*) FROM listings
                       WHERE id IN (${inPlaceholders(uniqueParentIds)})) AS parent_count,
                    EXISTS(SELECT 1 FROM listing_parents
                             WHERE child_listing_id IN (${inPlaceholders(uniqueParentIds)}))
                       AS parent_has_parent,
                    EXISTS(SELECT 1 FROM listing_parents
                             WHERE parent_listing_id IN (${inPlaceholders(uniqueChildIds)}))
                       AS child_has_children`,
    }),
  );

  // Existence: the parent side must still exist (the parent itself on the
  // children path, the submitted parents on the parents path), and the child
  // side must still exist (the parents path never reaches here because its
  // child id is a just-created listing).
  requireExists(
    state!.parent_count,
    parentSet.size,
    contract === "children" ? t("error.listing_deleted") : missingParentError,
  );
  requireExists(
    state!.child_count,
    childSet.size,
    t("error.child_listing_deleted"),
  );

  // Single-level nesting: the parent side can't already be a child, the child
  // side can't already be a parent. Precedence follows each writer's own order,
  // and a "clear the edges" save skips the parent-nesting block so a stuck
  // nested state can always be cleared.
  const nesting = nestingError(
    contract,
    state!.parent_has_parent,
    state!.child_has_children,
    childIds.length > 0,
  );
  if (nesting) throw new TransactionValidationError(nesting);
  // Package edge conflict. `contract === "parents"` gates the check on the
  // parent set's having edges, mirroring each writer's original call.
  return packageChildEdgeConflict(
    contract === "children" ? uniqueChildIds : uniqueParentIds,
    () => state!.parent_is_hidden_package_member === 1,
    () => state!.child_is_package_member === 1,
  );
};
