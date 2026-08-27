/** Contact-field building and paid-status checks for the booking form. The
 * contact fields rendered are the page listings' fields (required) plus any
 * extra a possible child requires (rendered non-required). Paid-status helpers
 * decide whether the provider-imposed email field renders required, present, or
 * not at all — each listing is paid through ANY path this page sells it. */

/* jscpd:ignore-start */
import type { TicketListing } from "#booking/model.ts";
import type { PagePackage } from "#booking/page-packages.ts";
import type { AddOnOption } from "#db/modifier-resolve.ts";
import type { Field } from "#shared/forms/field.ts";
import {
  getTicketFieldsSetting,
  mergeListingFields,
} from "#shared/listing-fields.ts";
import { getTicketFields } from "#templates/fields/ticket.ts";
import { isPaidListing } from "#types";

/* jscpd:ignore-end */

/** All possible children of the page's listings, flattened into one list. An
 * absent map (no children were loaded) means there are none. */
const childrenOf = (
  childrenByParentId: Map<number, TicketListing[]> | undefined,
): TicketListing[] =>
  childrenByParentId ? [...childrenByParentId.values()].flat() : [];

/**
 * The contact fields rendered on the booking form: every page listing's fields
 * (required) PLUS any extra field a possible child requires. A child with stricter
 * `fields` than its parent (e.g. parent collects email, child also wants
 * phone/address) is validated server-side for the *selected* child, but the buyer
 * must SEE that field to fill it — so it is rendered here NON-required (mirroring
 * the provider-email/`anyPaid` handling), since an unselected child or a
 * zero-quantity parent must not block submission. The page fields keep `required`.
 */
export const buildContactFields = (
  listings: TicketListing[],
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  pagePaid: boolean,
  anyPaid: boolean,
): Field[] => {
  const pageSetting = getTicketFieldsSetting(listings);
  const childSetting = getTicketFieldsSetting(childrenOf(childrenByParentId));
  const mergedSetting = mergeListingFields([pageSetting, childSetting]);
  // The provider-imposed paid email is a required page field only when the PAGE
  // itself is paid; a free page with a paid child renders it non-required (enforced
  // server-side once the folded order is actually paid). So `pageNames` uses
  // `pagePaid` while the rendered set uses `anyPaid` (so the email is present at all).
  const pageNames = new Set<string>(
    getTicketFields(pageSetting, pagePaid).map((f) => f.name),
  );
  return getTicketFields(mergedSetting, anyPaid).map((f) =>
    pageNames.has(f.name) ? f : { ...f, required: false },
  );
};

/** Whether a listing is paid through ANY path this page sells it. Each package
 * that bundles it prices it by that package's own rule: a flat override
 * REPLACES the base price for that path (an explicit free 0 makes the path
 * free), a positive per-day override makes a customisable member paid, and
 * without either the listing's own pricing decides. A listing nobody bundles —
 * or one ALSO sold on its own row beside its bundles — charges its own price
 * on the standalone path, whatever any bundle says. One cheap path never hides
 * a charging one: the buyer can always choose the paid path, so the provider
 * fields must render. */
const paidInContext = (
  info: TicketListing,
  packages: readonly PagePackage[],
  standaloneRowIds: ReadonlySet<number>,
): boolean => {
  const id = info.listing.id;
  const owners = packages.filter((pkg) => pkg.memberListingIds.includes(id));
  const paidVia = (pkg: PagePackage): boolean => {
    const override = pkg.prices.get(id);
    if (override !== undefined) return override > 0;
    const dayOverrides = pkg.dayPrices.get(id);
    if (dayOverrides && [...dayOverrides.values()].some((p) => p > 0)) {
      return true;
    }
    return isPaidListing(info.listing);
  };
  const sellsStandalone = owners.length === 0 || standaloneRowIds.has(id);
  return (
    owners.some(paidVia) || (sellsStandalone && isPaidListing(info.listing))
  );
};

/** The shared inputs to the paid-status checks: the page's listings, its opt-in
 * add-ons, its packages, and which listings keep a standalone row beside them.
 * Bundling these once avoids re-declaring the four params on each check. */
type PaidInput = {
  listings: TicketListing[];
  addOns: AddOnOption[] | undefined;
  packages: readonly PagePackage[];
  standaloneRowIds: ReadonlySet<number>;
};

/** Whether the page itself (its listings or add-ons, NOT possible children) is
 * paid — so its provider-imposed email renders required. */
export const pagePaid = ({
  addOns,
  listings,
  packages,
  standaloneRowIds,
}: PaidInput): boolean =>
  listings.some((e) => paidInContext(e, packages, standaloneRowIds)) ||
  (addOns?.some((addOn) => addOn.requiresPayment) ?? false);

/** Whether the contact-field set must include a paid order's provider-imposed
 * fields: any page listing, possible child, or add-on is paid. A free parent with
 * a paid child still needs the email field present (non-required, enforced
 * server-side when the folded order is actually paid). */
export const pageOrChildPaid = (
  input: PaidInput & {
    childrenByParentId: Map<number, TicketListing[]> | undefined;
  },
): boolean => {
  const children = childrenOf(input.childrenByParentId);
  return pagePaid(input) || children.some((e) => isPaidListing(e.listing));
};
