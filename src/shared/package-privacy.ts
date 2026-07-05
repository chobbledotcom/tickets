import {
  getPackageDisplayById,
  type PackageDisplay,
} from "#shared/db/groups.ts";

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
 *   - confirmation email + SVG ticket collapse → {@link packagePrivacyOfDisplay}
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
  for (const groupId of new Set(packageGroupIds)) {
    if ((await getPackageDisplayById(groupId))?.hideListings ?? true) {
      return true;
    }
  }
  return false;
};

/** Each concealed listing id → the package name standing in for it: every
 * hidden package's members, plus those members' required children (a child
 * booked as part of a hidden bundle must not be named either). The per-listing
 * form of {@link concealMemberNames} for pages selling several bundles. */
export const standInNamesByListingId = (
  packages: readonly {
    name: string;
    hideListings: boolean;
    memberListingIds: readonly number[];
  }[],
  childIdsOfMember: (memberListingId: number) => readonly number[],
): Map<number, string> => {
  const standIns = new Map<number, string>();
  for (const pkg of packages) {
    if (!pkg.hideListings) continue;
    for (const memberId of pkg.memberListingIds) {
      standIns.set(memberId, pkg.name);
      for (const childId of childIdsOfMember(memberId)) {
        standIns.set(childId, pkg.name);
      }
    }
  }
  return standIns;
};

/** Replace each concealed line's buyer-facing name with its package's name,
 * by listing id — the several-bundles form of {@link concealMemberNames}.
 * Prices, quantities and listing ids are untouched. A no-op when nothing on
 * the page is concealed. */
export const concealNamesByListingId = <
  T extends { name: string; listingId: number },
>(
  items: T[],
  standIns: ReadonlyMap<number, string>,
): T[] =>
  standIns.size === 0
    ? items
    : items.map((item) => {
        const standIn = standIns.get(item.listingId);
        return standIn === undefined ? item : { ...item, name: standIn };
      });
