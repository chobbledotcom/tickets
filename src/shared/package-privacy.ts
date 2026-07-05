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

/** The privacy the booking page ctx carries (set alongside `packageGroupId`
 * when the page is a package). */
export const packagePrivacyOfCtx = (ctx: {
  hidePackageListings?: boolean | undefined;
  groupName?: string | undefined;
}): PackagePrivacy =>
  ctx.hidePackageListings === true && ctx.groupName !== undefined
    ? { kind: "hidden", packageName: ctx.groupName }
    : VISIBLE;

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
 * from its persisted package group id: a package intent whose group no longer
 * resolves (deleted/un-packaged mid-checkout) reads as hidden, because the
 * stale group may have been a hidden package and the refund path must not name
 * its members either way. */
export const resolveNamesConcealed = async (
  packageGroupId: number | undefined,
): Promise<boolean> =>
  packageGroupId !== undefined &&
  ((await getPackageDisplayById(packageGroupId))?.hideListings ?? true);
