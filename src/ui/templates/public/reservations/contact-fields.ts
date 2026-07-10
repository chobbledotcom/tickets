import type { TicketListing } from "#shared/booking/model.ts";
import type { Field } from "#shared/forms.tsx";
import { mergeListingFields } from "#shared/listing-fields.ts";
import type { ListingFields } from "#shared/types.ts";
import { getTicketFields } from "#templates/fields/ticket.ts";

/** The merged fields setting across the selected listings. */
const getTicketFieldsSetting = (listings: TicketListing[]): ListingFields =>
  mergeListingFields(listings.map((e) => e.listing.fields));

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
  const children = childrenByParentId
    ? [...childrenByParentId.values()].flat()
    : [];
  const childSetting = mergeListingFields(
    children.map((e) => e.listing.fields),
  );
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
