import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { TicketListing } from "#booking/model.ts";
import type { PagePackage } from "#booking/page-packages.ts";
import { buildPageTree } from "#templates/public/reservations/availability.ts";
import {
  buildPageListingRows,
  renderListingDescription,
  soldOutLabel,
} from "#templates/public/reservations/listing-rows.ts";
import { quantityOptions } from "#templates/public/reservations/quantities.ts";
import type {
  BookingPrefill,
  ChildRenderCtx,
  TicketPrefill,
} from "#templates/public/reservations/types.ts";
import { resolved } from "#test-utils/booking-model-fixtures.ts";
import { pagePackage, tl } from "#test-utils/package-cap-fixtures.ts";

describe("soldOutLabel", () => {
  test("shows the Sold Out badge by default", () => {
    expect(soldOutLabel()).toBe('<span class="sold-out-label">Sold Out</span>');
  });

  test("shows the caller's copy when given", () => {
    expect(soldOutLabel("Registration Closed")).toBe(
      '<span class="sold-out-label">Registration Closed</span>',
    );
  });
});

describe("renderListingDescription", () => {
  test("wraps a description in the compact prose block", () => {
    expect(renderListingDescription("Hello there")).toBe(
      '<div class="description-compact"><p>Hello there</p>\n</div>',
    );
  });

  test("renders nothing for an empty description", () => {
    expect(renderListingDescription("")).toBe("");
  });
});

/** A package add-on select context under parent 7: one sole bookable add-on. */
const childCtx = (): ChildRenderCtx => ({
  attributesByListing: new Map(),
  childDatesById: new Map(),
  children: new Map([[7, [tl(10, 5, { name: "Add-on", slug: "add010" })]]]),
  foldReserveByChildId: new Map(),
  groupIdsByListingId: new Map(),
  groupRemainingByGroupId: new Map(),
  questionListingMap: undefined,
  questions: [],
  rendered: new Set(),
});

type RowOptions = {
  listings: TicketListing[];
  childCtx?: ChildRenderCtx;
  hideQuantity?: boolean;
  isSingleListing?: boolean;
  packages?: PagePackage[];
  /** Each package's remaining bundle count; defaults to 5 for every package. */
  packageLimits?: ReadonlyMap<number, number>;
  prefill?: BookingPrefill;
  /** A renewal page prices its counts by months per unit. */
  renewal?: boolean;
  singlePackagePage?: boolean;
  /** Members of a package that the cart also added by their own slug. */
  standaloneListingIds?: ReadonlySet<number>;
};

/** Render the listing area through the same tree trio the ticket page builds. */
const renderRows = ({
  hideQuantity = false,
  isSingleListing = false,
  packageLimits,
  packages = [],
  prefill,
  renewal,
  singlePackagePage = false,
  ...rest
}: RowOptions): string => {
  const { nodeByListingId, standaloneRowIds } = buildPageTree(
    {
      listings: rest.listings,
      packages,
      slugs: rest.listings.map((info) => info.listing.slug),
      ...(rest.standaloneListingIds
        ? { standaloneListingIds: rest.standaloneListingIds }
        : {}),
    },
    singlePackagePage ? 1 : packages.length,
  );
  return buildPageListingRows({
    attributesByListing: new Map(),
    childCtx: rest.childCtx,
    hideQuantity,
    isSingleListing,
    listings: rest.listings,
    nodeByListingId,
    packageLimits:
      packageLimits ??
      new Map(packages.map((pkg) => [pkg.groupId, 5] as const)),
    packages,
    prefill,
    renewal,
    singlePackagePage,
    standaloneRowIds,
  });
};

const rowListing = (id: number, name: string, slug: string): TicketListing =>
  tl(id, 10, { name, slug });

const occurrences = (html: string, needle: string): number =>
  html.split(needle).length - 1;

describe("buildPageListingRows", () => {
  test("renders one named quantity row per standalone listing", () => {
    const html = renderRows({
      listings: [
        rowListing(1, "Listing A", "ab12c"),
        rowListing(2, "Listing B", "cd34e"),
      ],
    });
    expect(html).toContain('<label>Listing A<select name="quantity_1">');
    expect(html).toContain('<label>Listing B<select name="quantity_2">');
    expect(occurrences(html, 'class="ticket-row"')).toBe(2);
    // The rows are joined edge to edge, and nothing renders in a row's
    // accessory slots (image, description, price, add-on selector).
    expect(html).toContain('</div>\n  \n    <div class="ticket-row">');
    expect(html).not.toContain("mutated");
  });

  test("a closed listing row names the registration as closed", () => {
    const closed = {
      ...resolved({ id: 1, name: "Listing A", slug: "ab12c" }, true),
      maxPurchasable: 0,
    };
    const html = renderRows({ listings: [closed] });
    expect(html).toContain("Registration Closed");
    expect(html).not.toContain('name="quantity_1"');
  });

  test("a row with pay-what-you-want renders its price input, a priced row does not", () => {
    const payMore = tl(2, 10, {
      can_pay_more: true,
      max_price: 5000,
      name: "Listing B",
      slug: "cd34e",
    });
    const html = renderRows({
      listings: [rowListing(1, "Listing A", "ab12c"), payMore],
    });
    expect(html).not.toContain('name="custom_price_1"');
    expect(html).toContain('name="custom_price_2"');
  });

  test("a parent row renders its add-on selector once, in the parent's own row", () => {
    const html = renderRows({
      childCtx: childCtx(),
      listings: [rowListing(7, "Parent", "pnt007")],
    });
    expect(occurrences(html, 'data-sole-parent="7"')).toBe(1);
    expect(html).toContain("Add-on");
  });

  test("the bare single-listing controls label the quantity and keep the prefill", () => {
    const prefill: BookingPrefill = {
      listings: new Map([[1, { quantity: 3 } satisfies TicketPrefill]]),
    };
    const html = renderRows({
      isSingleListing: true,
      listings: [rowListing(1, "Listing A", "ab12c")],
      prefill,
    });
    expect(html).toContain(
      '<label>Number of Tickets<select name="quantity_1">',
    );
    expect(html).toContain('<option value="3" selected>');
    expect(html).not.toContain("Listing A");
  });

  test("a page that hides quantity submits a fixed quantity instead of a chooser", () => {
    const html = renderRows({
      hideQuantity: true,
      isSingleListing: true,
      listings: [rowListing(1, "Listing A", "ab12c")],
    });
    expect(html).toContain(
      '<input type="hidden" name="quantity_1" value="1" />',
    );
    expect(html).not.toContain("Number of");
    expect(html).not.toContain('<select name="quantity_1">');
  });

  test("a built-site plan is sold in months, an ordinary listing in tickets", () => {
    const plan = tl(1, 5, {
      assign_built_site: true,
      initial_site_months: 3,
      name: "Listing A",
      slug: "ab12c",
    });
    const planHtml = renderRows({
      isSingleListing: true,
      listings: [plan],
    });
    // Each option states the months it buys: three units of a three-month
    // plan are nine months.
    expect(planHtml).toContain('<option value="1">3 months</option>');
    expect(planHtml).toContain('<option value="2">6 months</option>');
    expect(planHtml).toContain(
      '<label>Number of months<select name="quantity_1">',
    );
    expect(planHtml).not.toContain("Number of Tickets");
    expect(planHtml).not.toContain('">2</option>');

    const ordinaryHtml = renderRows({
      isSingleListing: true,
      listings: [rowListing(1, "Listing A", "ab12c")],
    });
    expect(ordinaryHtml).toContain(
      '<label>Number of Tickets<select name="quantity_1">',
    );
    expect(ordinaryHtml).toContain('<option value="2">2</option>');
    expect(ordinaryHtml).not.toContain("Number of months");
  });

  test("a renewal page prices every tier by its months per unit", () => {
    const plan = tl(1, 5, {
      assign_built_site: true,
      initial_site_months: 3,
      months_per_unit: 1,
      name: "(3 Months)",
      slug: "ab12c",
    });
    const html = renderRows({
      isSingleListing: true,
      listings: [plan],
      renewal: true,
    });
    expect(html).toContain('<label>Number of months<select name="quantity_1">');
    // Fulfillment extends the site by months per unit: two units of a
    // one-month-per-unit tier are two months, not the plan's initial three.
    expect(html).toContain('<option value="2">2 months</option>');
    expect(html).not.toContain("6 months");
  });

  test("a single-package page counts bundles and renders each member at its fixed quantity", () => {
    const html = renderRows({
      listings: [rowListing(7, "Listing A", "ab12c")],
      packages: [pagePackage(3, [7], { quantities: new Map([[7, 2]]) })],
      singlePackagePage: true,
    });
    expect(html).toContain('data-package-members="7:2"');
    expect(html).toContain("Number of packages");
    expect(html).toContain("&times;2");
    expect(html).toContain('<option value="1" selected>');
    expect(html).not.toContain('name="quantity_7"');
    expect(html).not.toContain("mutated");
  });

  test("a plan member's fixed count reads as the months it grants", () => {
    const planMember = tl(7, 5, {
      assign_built_site: true,
      initial_site_months: 1,
      name: "Listing A",
      slug: "ab12c",
    });
    const html = renderRows({
      listings: [planMember],
      packages: [pagePackage(3, [7], { quantities: new Map([[7, 2]]) })],
      singlePackagePage: true,
    });
    // Two units of a one-month plan are two months per package, not two sites.
    expect(html).toContain("&times;2 (2 months)");
    expect(html).toContain('data-package-members="7:2"');
  });

  test("a member missing from the quantity map counts one per package", () => {
    const html = renderRows({
      listings: [rowListing(7, "Listing A", "ab12c")],
      packages: [pagePackage(3, [7], { quantities: new Map() })],
      singlePackagePage: true,
    });
    expect(html).toContain('data-package-members="7:1"');
    expect(html).toContain("&times;1");
  });

  test("a member's stored zero quantity is kept, not swapped for the default one", () => {
    const html = renderRows({
      listings: [
        rowListing(7, "Listing A", "ab12c"),
        rowListing(8, "Listing B", "cd34e"),
      ],
      packages: [pagePackage(3, [7, 8], { quantities: new Map([[8, 0]]) })],
      singlePackagePage: true,
    });
    expect(html).toContain('data-package-members="7:1 8:0"');
    expect(html).toContain("&times;0");
  });

  test("each package on a mixed page sells under its own count", () => {
    const html = renderRows({
      listings: [
        rowListing(7, "Listing A", "ab12c"),
        rowListing(8, "Listing B", "cd34e"),
      ],
      packages: [pagePackage(3, [7]), pagePackage(4, [8])],
    });
    expect(html).toContain("package_quantity_3");
    expect(html).toContain("package_quantity_4");
    expect(html).toContain("<legend>Package 3</legend>");
    expect(html).toContain("<legend>Package 4</legend>");
    // The sections render edge to edge, with no filler between them.
    expect(html).toContain(
      '</fieldset><fieldset class="ticket-package" data-package-section="4">',
    );
  });

  test("a titled bundle section renders its description above its controls", () => {
    const html = renderRows({
      listings: [
        rowListing(7, "Listing A", "ab12c"),
        rowListing(8, "Listing B", "cd34e"),
      ],
      packages: [
        pagePackage(3, [7], { description: "Two together" }),
        pagePackage(4, [8]),
      ],
    });
    expect(html).toContain("<p>Two together</p>");
    expect(html).toContain("<legend>Package 3</legend>");
    // A living bundle carries no sold-out marker on its fieldset.
    expect(html).toContain(
      '<fieldset class="ticket-package" data-package-section="3">',
    );
  });

  test("a package that hides its listings shows only its bundle count", () => {
    const html = renderRows({
      listings: [rowListing(7, "Listing A", "ab12c")],
      packages: [
        pagePackage(3, [7], { hideListings: true, quantities: new Map() }),
      ],
      singlePackagePage: true,
    });
    expect(html).toBe(
      `<label>Number of packages<select name="package_quantity_3" data-package-members="7:1">${quantityOptions(5, 1)}</select></label>`,
    );
    expect(html).not.toContain("Listing A");
  });

  test("a bundle with no room left renders a sold-out card without controls", () => {
    const html = renderRows({
      listings: [rowListing(7, "Listing A", "ab12c")],
      packageLimits: new Map([[3, 0]]),
      packages: [pagePackage(3, [7], { description: "Two together" })],
    });
    expect(html).toContain('class="ticket-package sold-out"');
    expect(html).not.toContain("package_quantity_3");
    expect(html).not.toContain("Two together");
    expect(html).toContain("Sold Out");
  });

  test("a shared parent keeps its add-on selector on one row when the cart also added it", () => {
    const html = renderRows({
      childCtx: childCtx(),
      listings: [rowListing(7, "Parent", "pnt007")],
      packages: [pagePackage(3, [7], { quantities: new Map([[7, 2]]) })],
      standaloneListingIds: new Set([7]),
    });
    expect(occurrences(html, 'data-sole-parent="7"')).toBe(1);
    expect(html).toContain("&times;2");
    expect(html).toContain('name="quantity_7"');
  });
});
