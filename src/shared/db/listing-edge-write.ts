/**
 * The shared transaction-local guard behind both parent/child edge writers.
 * They differ only in which side is the single fixed listing and which the
 * submitted set, so the caller states which ids fill the PARENT role and which
 * the CHILD role.
 *
 * One declared check list, rather than a per-writer SELECT, is what keeps the
 * two writers in step.
 */

import { resultRows, type TxScope } from "#db/client.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { t } from "#i18n";
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
  // The parents contract is the catalog import. "Reload and try again" is no
  // help there. The named parent was already a child before the file was read,
  // so the fix is to change the file.
  if (hasParent) return t("error.parent_is_already_a_child");
  return null;
};

const requireExists = (
  count: number,
  expected: number,
  message: string,
): void => {
  if (count !== expected) throw new TransactionValidationError(message);
};

/** Whether any of these listings sits inside a package group. The hidden-only
 *  form also requires the package to hide what is inside it. */
const packageMembershipExists = (
  listingSlots: string,
  hiddenOnly: boolean,
): string =>
  `EXISTS(SELECT 1
           FROM group_listings AS membership
                JOIN groups AS package
                  ON package.id = membership.group_id
           WHERE membership.listing_id IN (${listingSlots})
             AND package.is_package = 1${hiddenOnly ? " AND package.hide_package_listings = 1" : ""})`;

/** Whether any parent→child edge names one of these listings on that side of
 *  the edge. */
const edgeExists = (
  edgeColumn: "child_listing_id" | "parent_listing_id",
  listingSlots: string,
): string =>
  `EXISTS(SELECT 1 FROM listing_parents
           WHERE ${edgeColumn} IN (${listingSlots}))`;

const listingCount = (listingSlots: string): string =>
  `(SELECT COUNT(*) FROM listings WHERE id IN (${listingSlots}))`;

/** The edge-state checks shared by both writers, in one SELECT. `parentIds`/`
 *  `childIds` are the role id sets; each set is bound once and its slots
 *  reused by every check that reads it, so the query never builds an empty
 *  `IN ()`. */
export const guardEdgeWriteTx = async (
  input: GuardEdgeWriteInput,
): Promise<PackageChildEdgeBlock | null> => {
  const { tx, parentIds, childIds, missingParentError, contract } = input;
  const parentSet = new Set(parentIds);
  const childSet = new Set(childIds);
  const uniqueParentIds = [...parentSet];
  const uniqueChildIds = [...childSet];

  const [state] = resultRows<EdgeState>(
    await tx.execute(
      numberedStatement((bind) => {
        const childSlots = uniqueChildIds.map(bind).join(", ");
        const parentSlots = uniqueParentIds.map(bind).join(", ");
        // One fact per line, named for the role set it reads.
        return `SELECT
          ${packageMembershipExists(childSlots, false)} AS child_is_package_member,
          ${packageMembershipExists(parentSlots, true)} AS parent_is_hidden_package_member,
          ${listingCount(childSlots)} AS child_count,
          ${listingCount(parentSlots)} AS parent_count,
          ${edgeExists("child_listing_id", parentSlots)} AS parent_has_parent,
          ${edgeExists("parent_listing_id", childSlots)} AS child_has_children`;
      }),
    ),
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
