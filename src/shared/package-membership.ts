/**
 * Pure rules for whether a listing can be a member of a package, shared by the
 * group-side save (`features/admin/groups.ts`), the listing-side save
 * (`shared/listings-actions.ts`), and the catalog importer — so the rule and
 * its user-facing message live in one place instead of three near-copies.
 *
 * A package sets a fixed price for each member and sells the whole bundle, so:
 *  - a pay-what-you-want listing can't be a member (there is no fixed member
 *    price for the bundle to charge);
 *  - a listing that is itself another listing's add-on (child) can't be a
 *    member (it is only ever sold alongside that listing, never on its own in a
 *    bundle);
 *  - on a HIDDEN package — where members collapse to the package name on every
 *    buyer surface — a member that gates its own children can't be a member,
 *    because its child selector would name the very listings the package hides.
 *    A VISIBLE package renders that selector fine, so this rule only bites when
 *    the package hides its listings.
 */
import { t } from "#i18n";

/** Why a listing can't be a package member (null means it can). */
export type PackageMemberBlock =
  | "pay_more"
  | "is_addon"
  | "gates_children_hidden";

/** The parent/child edges touching a listing, as the block rule reads them. */
type MemberEdges = {
  childIds: readonly number[];
  parentIds: readonly number[];
};

/**
 * The reason a listing can't be a package member, or null when it can. Pure:
 * the caller supplies the listing's pay-more flag, its touching edges, and
 * whether the package hides its listings.
 */
export const packageMemberBlock = (
  listing: { can_pay_more: boolean },
  edges: MemberEdges,
  // Undefined (an input that omitted the flag) reads as "not hidden".
  hidePackageListings: boolean | undefined,
): PackageMemberBlock | null => {
  if (listing.can_pay_more) return "pay_more";
  if (edges.parentIds.length > 0) return "is_addon";
  if (hidePackageListings && edges.childIds.length > 0) {
    return "gates_children_hidden";
  }
  return null;
};

/**
 * The user-facing error for a blocked package member, naming the listing and
 * the specific reason. Every message begins "Packages cannot contain …" so the
 * operator sees which of their listings is the problem and exactly how to fix
 * it, instead of one catch-all listing every rule at once.
 */
export const packageMemberBlockError = (
  name: string,
  block: PackageMemberBlock,
): string => t(`error.package_member_${block}`, { name });

/**
 * Why a would-be parent/child edge conflicts with package membership — distinct
 * from {@link PackageMemberBlock} (which is about a listing JOINING a package):
 *  - `gate_in_hidden`: the listing gaining children is in a HIDDEN package, so
 *    its add-on selector would name the listings the package conceals;
 *  - `child_is_member`: a chosen child belongs to a package, so it can't also
 *    be sold as another listing's add-on.
 */
export type PackageChildEdgeBlock = "gate_in_hidden" | "child_is_member";

/** The user-facing error for a package / child-edge conflict. */
export const packageChildEdgeError = (block: PackageChildEdgeBlock): string =>
  t(`error.package_${block}`);
