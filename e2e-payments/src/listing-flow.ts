import { type BrowserSession, clickControlOn, hrefOf } from "./browser.ts";
import { catalogWords } from "./catalog-words.ts";
import { log, step } from "./log.ts";

/** The fields one published listing is created with. */
export type ListingFields = {
  name: string;
  priceMinor: number;
  sitePlanMonths?: number;
};

/**
 * Create a listing that collects an email and (when priced > 0) requires
 * payment. `sitePlanMonths` additionally sells the listing as a built-site
 * plan buying that many months per unit (the app only offers those fields
 * while the builder is enabled, which the harness's app server is). Returns
 * the public `/ticket/<slug>` path for booking.
 */
export const createListing = async (
  session: BrowserSession,
  { priceMinor, name, sitePlanMonths }: ListingFields,
): Promise<string> => {
  step(
    sitePlanMonths === undefined
      ? `Creating listing "${name}" (price=${priceMinor} minor units)`
      : `Creating site-plan listing "${name}" (price=${priceMinor}, ${sitePlanMonths} months per unit)`,
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
  if (sitePlanMonths !== undefined) {
    // The plan's fields sit in the collapsed Advanced settings section, so
    // open it the way an owner does before checking them.
    await clickControlOn(
      session.page,
      session.page.locator("details.listing-advanced > summary"),
    );
    await session.check("assign_built_site", "1");
    await session.fill("initial_site_months", String(sitePlanMonths));
  }
  await session.clickButton(
    await catalogWords("listings-table", "listings_table.create_listing"),
  );

  // Open the new listing and read its public booking link.
  await session.goto("/admin/");
  await session.clickLink(name);
  const href = await hrefOf(
    session.page.locator('a[href*="/ticket/"]').first(),
    "no public /ticket/ link found on the listing page",
  );
  const path = href.startsWith("http") ? new URL(href).pathname : href;
  log(`  public booking path: ${path}`);
  return path;
};
