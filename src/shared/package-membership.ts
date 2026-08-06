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
/* jscpd:ignore-start */
import { t } from "#i18n";
import { firstReason, type Reason, reason } from "#shared/reasons.ts";

/* jscpd:ignore-end */

/** The listing fields the member rules read; the name is for the message. */
type MemberListing = { name: string; can_pay_more: boolean };

/** The parent/child edges touching a listing, as the member rules read them. */
type MemberEdges = {
  childIds: readonly number[];
  parentIds: readonly number[];
};

/** A member rule over the listing, its touching edges, and whether the package
 * hides its listings (an input that omitted the flag reads as "not hidden"). */
type MemberReason = Reason<
  [
    listing: MemberListing,
    edges: MemberEdges,
    hidePackageListings: boolean | undefined,
  ]
>;

/** A member rule whose message names the blocked listing. Every message begins
 * "Packages cannot contain …" so the operator sees which of their listings is
 * the problem and exactly how to fix it. */
const memberReason = (
  messageKey: string,
  blocks: (
    listing: MemberListing,
    edges: MemberEdges,
    hidePackageListings: boolean | undefined,
  ) => boolean,
): MemberReason =>
  reason(blocks, (listing) =>
    t(`error.package_member_${messageKey}`, { name: listing.name }),
  );

/** The member rules as data, in precedence order. */
const PACKAGE_MEMBER_RULES: readonly MemberReason[] = [
  memberReason("pay_more", (listing) => listing.can_pay_more),
  memberReason("is_addon", (_listing, edges) => edges.parentIds.length > 0),
  memberReason(
    "gates_children_hidden",
    (_listing, edges, hidePackageListings) =>
      hidePackageListings === true && edges.childIds.length > 0,
  ),
];

/**
 * The user-facing error naming the listing and the specific reason it can't be
 * a package member, or null when it can. Pure: the caller supplies the
 * listing's name and pay-more flag, its touching edges, and whether the
 * package hides its listings.
 */
export const packageMemberError: MemberReason =
  firstReason(PACKAGE_MEMBER_RULES);

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
