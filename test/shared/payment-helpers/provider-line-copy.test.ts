import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { providerLineCopy } from "#shared/payment-helpers.ts";
import { checkoutItem as buildCheckoutItem } from "#shared/payments.ts";
import { checkoutItem } from "#test-utils/checkout.ts";
import { testListing } from "#test-utils/factories.ts";

describe("checkoutItem", () => {
  test("carries the plan's initial term for an assigned-site listing", () => {
    const plan = testListing({
      assign_built_site: true,
      initial_site_months: 3,
      name: "(3 Months)",
      slug: "p3m",
    });
    expect(buildCheckoutItem(plan, 2, 4500)).toEqual({
      initialSiteMonths: 3,
      listingId: plan.id,
      name: "(3 Months)",
      quantity: 2,
      slug: "p3m",
      unitPrice: 4500,
    });
  });

  test("carries no term when an ordinary listing lacks the flags entirely", () => {
    const listing = testListing({ name: "Gala", slug: "gala" });
    delete (listing as { assign_built_site?: unknown }).assign_built_site;
    expect(
      Object.hasOwn(buildCheckoutItem(listing, 1, 1000), "initialSiteMonths"),
    ).toBe(false);
  });

  test("keeps an ordinary listing a ticket line", () => {
    const listing = testListing({ name: "Gala", slug: "gala" });
    expect(buildCheckoutItem(listing, 1, 1000)).toEqual({
      listingId: listing.id,
      name: "Gala",
      quantity: 1,
      slug: "gala",
      unitPrice: 1000,
    });
  });

  test("carries no term for a plan whose initial months are zero", () => {
    const listing = testListing({
      assign_built_site: true,
      initial_site_months: 0,
      name: "Zero",
      slug: "zero",
    });
    expect(
      Object.hasOwn(buildCheckoutItem(listing, 1, 0), "initialSiteMonths"),
    ).toBe(false);
  });

  test("carries no term for a plan that states no initial months", () => {
    // A JSON API create may omit the field entirely; the stored column
    // default (0) rejects such plans only after parsing.
    const listing = {
      ...testListing({
        assign_built_site: true,
        name: "Unstated",
        slug: "unst",
      }),
    };
    delete (listing as { initial_site_months?: number }).initial_site_months;
    expect(
      Object.hasOwn(buildCheckoutItem(listing, 1, 0), "initialSiteMonths"),
    ).toBe(false);
  });
});

describe("providerLineCopy", () => {
  test("prices a plan line by the months one unit buys", () => {
    expect(
      providerLineCopy(checkoutItem({ initialSiteMonths: 3, name: "Plan" }), 2),
    ).toEqual({ description: "3 months", name: "Site plan: Plan" });
    expect(
      providerLineCopy(checkoutItem({ initialSiteMonths: 1, name: "Plan" }), 4),
    ).toEqual({ description: "1 month", name: "Site plan: Plan" });
  });

  test("keeps ticket wording for ordinary lines", () => {
    expect(providerLineCopy(checkoutItem({ name: "Gala" }), 1)).toEqual({
      description: "Ticket",
      name: "Ticket: Gala",
    });
    expect(providerLineCopy(checkoutItem({ name: "Gala" }), 3)).toEqual({
      description: "3 Tickets",
      name: "Ticket: Gala",
    });
  });
});
