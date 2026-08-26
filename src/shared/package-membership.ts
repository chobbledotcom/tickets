/**
 * Shared by the group save, the listing save and the catalog importer, so the
 * rule and its user-facing message live in one place.
 *
 * A package sets a fixed price per member and sells the whole bundle, so:
 *  - a pay-what-you-want listing has no fixed member price to charge.
 *  - a child listing is only ever sold alongside its parent.
 *  - on a HIDDEN package, a member that gates its own children would show a
 *    child selector naming the very listings the package hides. A VISIBLE
 *    package renders that selector fine.
 */
/* jscpd:ignore-start */
import { t } from "#i18n";

/* jscpd:ignore-end */

/** The listing fields the member rules read; the name is for the message. */
type MemberListing = { name: string; can_pay_more: boolean };
type MemberRuleListing = Pick<MemberListing, "can_pay_more">;

/** The parent/child edges touching a listing, as the member rules read them. */
type MemberEdges = {
  childIds: readonly number[];
  parentIds: readonly number[];
};

/** The member rules' block checks as data, in precedence order. The name is
 *  only needed for the error message, so callers can check membership rules
 *  without decrypting, then decrypt only the listing that fails. */
type MemberBlockKey = "pay_more" | "is_addon" | "gates_children_hidden";

type MemberBlockPredicate = (
  listing: MemberRuleListing,
  edges: MemberEdges,
  hidePackageListings: boolean | undefined,
) => boolean;

const PACKAGE_MEMBER_BLOCKS: ReadonlyArray<{
  key: MemberBlockKey;
  blocks: MemberBlockPredicate;
}> = [
  { blocks: (listing) => listing.can_pay_more, key: "pay_more" },
  {
    blocks: (_listing, edges) => edges.parentIds.length > 0,
    key: "is_addon",
  },
  {
    blocks: (_listing, edges, hidePackageListings) =>
      hidePackageListings === true && edges.childIds.length > 0,
    key: "gates_children_hidden",
  },
];

/** The first rule that blocks a listing from a package, without needing the
 *  listing's name — so the caller can check without decrypting. */
export const memberBlockKey = (
  listing: MemberRuleListing,
  edges: MemberEdges,
  hidePackageListings: boolean | undefined,
): MemberBlockKey | null => {
  for (const { key, blocks } of PACKAGE_MEMBER_BLOCKS) {
    if (blocks(listing, edges, hidePackageListings)) return key;
  }
  return null;
};

/** The user-facing message for a known block key, naming the listing. */
export const packageMemberMessage = (
  key: MemberBlockKey,
  name: string,
): string => t(`error.package_member_${key}`, { name });

/**
 * The user-facing error naming the listing and the specific reason it can't be
 * a package member, or null when it can. Pure: the caller supplies the
 * listing's name and pay-more flag, its touching edges, and whether the
 * package hides its listings.
 */
export const packageMemberError = (
  listing: MemberListing,
  edges: MemberEdges,
  hidePackageListings: boolean | undefined,
): string | null => {
  const key = memberBlockKey(listing, edges, hidePackageListings);
  return key ? packageMemberMessage(key, listing.name) : null;
};

/**
 * Why a would-be parent/child edge conflicts with package membership — distinct
 * from {@link packageMemberError} (which is about a listing JOINING a package):
 *  - `gate_in_hidden`: the listing gaining children is in a HIDDEN package, so
 *    its add-on selector would name the listings the package conceals;
 *  - `child_is_member`: a chosen child belongs to a package, so it can't also
 *    be sold as another listing's add-on.
 */
export type PackageChildEdgeBlock = "gate_in_hidden" | "child_is_member";

/** Whether a proposed edge set can expose either package-child conflict. */
export const hasChildEdges = (childIds: readonly number[]): boolean =>
  childIds.length > 0;

export const packageGroups = <Group extends { is_package: boolean }>(
  groups: readonly Group[],
): Group[] => groups.filter((group) => group.is_package);

type PackageEdgeCheck = () => boolean | Promise<boolean>;

/** Finds the first package rule broken by a proposed child-edge set. */
export const packageChildEdgeConflict = async (
  childIds: readonly number[],
  parentIsHiddenPackageMember: PackageEdgeCheck,
  childIsPackageMember: PackageEdgeCheck,
): Promise<PackageChildEdgeBlock | null> => {
  if (!hasChildEdges(childIds)) return null;
  if (await parentIsHiddenPackageMember()) return "gate_in_hidden";
  return (await childIsPackageMember()) ? "child_is_member" : null;
};

/** The user-facing error for a package / child-edge conflict. */
export const packageChildEdgeError = (block: PackageChildEdgeBlock): string =>
  t(`error.package_${block}`);

/** Converts an optional edge conflict into its operator-facing message. */
export const packageChildEdgeErrorOrNull = (
  block: PackageChildEdgeBlock | null,
): string | null => (block ? packageChildEdgeError(block) : null);
