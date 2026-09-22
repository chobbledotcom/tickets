import { type BrowserSession, clickControlOn, hrefOf } from "./browser.ts";
import { catalogWords } from "./catalog-words.ts";
import { log, step } from "./log.ts";

/** The fields one published listing is created with. */
export type ListingFields = {
  name: string;
  priceMinor: number;
  /** Publish as the hidden, purchase-only renewal tier priced per month —
   * the listing a site-plan install needs so an assigned site can renew. */
  renewalTierMonths?: number;
  sitePlanMonths?: number;
};

/** Fill and submit the admin listing form for one new listing, whatever its
 * kind — plain, site plan, or hidden renewal tier. */
export const submitListingForm = async (
  session: BrowserSession,
  { priceMinor, name, renewalTierMonths, sitePlanMonths }: ListingFields,
): Promise<void> => {
  step(
    `Creating listing "${name}" (price=${priceMinor} minor units` +
      (sitePlanMonths !== undefined
        ? `, ${sitePlanMonths} months per unit`
        : "") +
      (renewalTierMonths !== undefined ? ", renewal tier" : "") +
      ")",
  );
  await session.goto("/admin/listing/new?template=custom");
  await session.fill("name", name);
  // The description is a rich markdown editor whose backing textarea is
  // hidden — type into the visible editing surface like a person.
  await session.typeInto(
    ".md-editor .ProseMirror",
    "End-to-end payment test listing",
  );
  await session.fill("max_attendees", "100");
  await session.fill("max_quantity", "5");
  await session.check("fields", "email");
  // The price field is entered in major units (e.g. "1.00"), not minor.
  await session.fill("unit_price", (priceMinor / 100).toFixed(2));
  if (sitePlanMonths !== undefined || renewalTierMonths !== undefined) {
    // The builder-only fields sit in the collapsed Advanced settings section,
    // so open it the way an owner does before filling them.
    await clickControlOn(
      session.page,
      session.page.locator("details.listing-advanced > summary"),
    );
  }
  if (sitePlanMonths !== undefined) {
    await session.check("assign_built_site", "1");
    await session.fill("initial_site_months", String(sitePlanMonths));
  }
  if (renewalTierMonths !== undefined) {
    await session.check("hidden", "1");
    await session.check("purchase_only", "1");
    await session.fill("months_per_unit", String(renewalTierMonths));
  }
  await session.clickButton(
    await catalogWords("listings-table", "listings_table.create_listing"),
  );
};

/**
 * Create a visible listing through the real admin form and return its public
 * `/ticket/<slug>` booking path. `sitePlanMonths` additionally sells the
 * listing as a built-site plan buying that many months per unit (the app
 * only offers those fields while the builder is enabled, which the harness's
 * app server is).
 */
export const createListing = async (
  session: BrowserSession,
  fields: ListingFields,
): Promise<string> => {
  await submitListingForm(session, fields);

  // Open the new listing and read its public booking link.
  await session.goto("/admin/");
  await session.clickLink(fields.name);
  const href = await hrefOf(
    session.page.locator('a[href*="/ticket/"]').first(),
    "no public /ticket/ link found on the listing page",
  );
  const path = href.startsWith("http") ? new URL(href).pathname : href;
  log(`  public booking path: ${path}`);
  return path;
};
