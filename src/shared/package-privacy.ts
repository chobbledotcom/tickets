import { getPackageDisplaysByIds, type PackageDisplay } from "#db/groups.ts";

/**
 * HIDDEN-PACKAGE PRIVACY — the one chokepoint deciding what a BUYER may see of
 * a package's member listings. A package with `hide_package_listings` sells as
 * one concealed bundle: its member names must never reach a buyer-facing
 * surface. Every such surface resolves member visibility through THIS module —
 * a {@link PackagePrivacy} built by a constructor on the way in, applied by a
 * helper on the way out — never by reading `hide_package_listings` ad hoc:
 *
 *   - checkout/quote line names → {@link concealMemberNames}
 *   - day-count + payment error text → {@link memberStandInName} /
 *     {@link resolveNamesConcealed}
 *   - confirmation email + SVG ticket collapse → `buyerEntryGroups`
 *     (email-renderer.ts; per package, so mixed carts conceal every bundle)
 *   - /t package cards, public API member lists → {@link namesConcealed}
 *
 * A surface added tomorrow takes a `PackagePrivacy` and cannot leak a member
 * name without visibly bypassing this module. (Access-level guards — the 404s
 * on a hidden member's own page/API/wallet routes — live beside the membership
 * queries in db/groups.ts; this module owns display redaction.)
 */

export type PackagePrivacy =
  | { readonly kind: "visible" }
  | { readonly kind: "hidden"; readonly packageName: string };

const VISIBLE: PackagePrivacy = { kind: "visible" };

/** The privacy of a package whose row is in hand (the booking ctx build, the
 * package API's group): hidden members stand behind the package's name. */
export const packagePrivacy = (
  hideListings: boolean,
  packageName: string,
): PackagePrivacy => (hideListings ? { kind: "hidden", packageName } : VISIBLE);

/** The privacy of an order's loaded {@link PackageDisplay} (emails, SVG
 * tickets, ticket cards); a null display — not a package order — is visible. */
export const packagePrivacyOfDisplay = (
  display: PackageDisplay | null,
): PackagePrivacy =>
  display === null
    ? VISIBLE
    : packagePrivacy(display.hideListings, display.name);

/** Whether the member names are concealed from buyers. */
export const namesConcealed = (privacy: PackagePrivacy): boolean =>
  privacy.kind === "hidden";

/** The package name standing in for a concealed member in buyer-facing error
 * text, or undefined when members are visible (name the member as usual). */
export const memberStandInName = (
  privacy: PackagePrivacy,
): string | undefined =>
  privacy.kind === "hidden" ? privacy.packageName : undefined;

/** For a HIDDEN package, replace each line's buyer-facing name with the
 * package name — hosted checkouts (Stripe/Square render the item name), the
 * /calculate quote, and the stored registration items all pass through here.
 * Prices, quantities and listing ids are untouched, so the webhook still
 * revalidates each member. A no-op for a visible package or a non-package. */
export const concealMemberNames = <T extends { name: string }>(
  items: T[],
  privacy: PackagePrivacy,
): T[] =>
  privacy.kind === "hidden"
    ? items.map((item) => ({ ...item, name: privacy.packageName }))
    : items;

/** Whether a SIGNED order's member names must be concealed, resolved fail-safe
 * from its persisted package group ids: hidden when ANY booked package hides
 * its listings, and a group that no longer resolves (deleted/un-packaged
 * mid-checkout) reads as hidden, because the stale group may have been a hidden
 * package and the refund path must not name its members either way. An order
 * with no packages conceals nothing. */
export const resolveNamesConcealed = async (
  packageGroupIds: Iterable<number>,
): Promise<boolean> => {
  const groupIds = [...new Set(packageGroupIds)];
  const displays = await getPackageDisplaysByIds(groupIds);
  return groupIds.some(
    (groupId) => displays.get(groupId)?.hideListings ?? true,
  );
};

/** The stand-in names concealing a page's hidden bundles, for pages selling
 * several packages at once — the several-bundles form of
 * {@link concealMemberNames}. */
export type PackageStandIns = {
  /** Hidden package name by ITS group id: renames the checkout lines TAGGED
   * with that package. A line booked through a different path — a visible
   * package, or the listing's own row — keeps its real name: the hidden
   * bundle's contents stay concealed because only ITS OWN line is renamed,
   * and a wrong-bundle label would mislead the buyer about what each line
   * charges for. */
  byGroupId: ReadonlyMap<number, string>;
  /** Hidden package name by member/child listing id: renames UNTAGGED lines
   * (a required child folded under a hidden bundle's member rides an untagged
   * line) and feeds per-listing error text. Fail-safe by listing — an error
   * about a hidden package's member never names it, whatever path it took. */
  byListingId: ReadonlyMap<number, string>;
};

/** The package facts the stand-in builders read. */
type StandInPackage = {
  groupId: number;
  name: string;
  hideListings: boolean;
  memberListingIds: readonly number[];
};

/** Build the page's stand-ins: every hidden package's name keyed by its group
 * id, plus each of its members and those members' required children by listing
 * id (a child booked as part of a hidden bundle must not be named either). */
export const packageStandIns = (
  packages: readonly StandInPackage[],
  childIdsOfMember: (memberListingId: number) => readonly number[],
): PackageStandIns => {
  const byGroupId = new Map<number, string>();
  const byListingId = new Map<number, string>();
  for (const pkg of packages) {
    if (!pkg.hideListings) continue;
    byGroupId.set(pkg.groupId, pkg.name);
    for (const memberId of pkg.memberListingIds) {
      byListingId.set(memberId, pkg.name);
      for (const childId of childIdsOfMember(memberId)) {
        byListingId.set(childId, pkg.name);
      }
    }
  }
  return { byGroupId, byListingId };
};

/** This page's hidden-package stand-ins: every HIDDEN package's name by group
 * id (for its tagged lines) and by member/child listing id (for folded-child
 * lines, error text, and conflict notes). Buyer-facing line names and error
 * text resolve through these maps so a concealed member is never named. Empty
 * when nothing on the page is concealed. */
export const ctxStandInNames = (ctx: {
  packages: readonly StandInPackage[];
  childrenByParentId: ReadonlyMap<
    number,
    readonly { listing: { id: number } }[]
  >;
}): PackageStandIns =>
  packageStandIns(ctx.packages, (memberId) =>
    (ctx.childrenByParentId.get(memberId) ?? []).map(
      (child) => child.listing.id,
    ),
  );

/** Replace each concealed line's buyer-facing name with its package's name: a
 * line TAGGED with a hidden package takes that package's name; an untagged
 * line (a folded child) is concealed by listing id. Prices, quantities and
 * listing ids are untouched. A no-op when nothing on the page is concealed. */
export const concealLineNames = <
  T extends {
    name: string;
    listingId: number;
    packageGroupId?: number | undefined;
  },
>(
  items: T[],
  standIns: PackageStandIns,
): T[] =>
  standIns.byGroupId.size === 0
    ? items
    : items.map((item) => {
        const standIn =
          item.packageGroupId === undefined
            ? standIns.byListingId.get(item.listingId)
            : standIns.byGroupId.get(item.packageGroupId);
        return standIn === undefined ? item : { ...item, name: standIn };
      });
