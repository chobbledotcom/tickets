/**
 * The package endpoints publish an example bundle and an example booking of it.
 * These check the pair describes one package a caller could really buy.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { PUBLIC_API_ENDPOINTS } from "#shared/admin-api-example.ts";
import {
  PackageBookRequestSchema,
  PackageResponseSchema,
} from "#test-utils/api-schemas.ts";
import { documented } from "./helpers.ts";

describe("documented package endpoints", () => {
  /** One member of the documented package, with any add-ons it publishes. */
  type PackageMember = {
    quantity: number;
    slug: string;
    children?: { maxPurchasable: number; slug: string }[];
  };

  /** One add-on the documented booking chooses, under its member. */
  type Selection = { parent: string; quantity: number; slug: string };

  const documentedPackage = () =>
    JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "GET", "/api/packages/:slug").response,
    ).package;

  const documentedBooking = () =>
    JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "POST", "/api/packages/:slug/book")
        .request!,
    );

  test("the documented package is one a caller could really buy", () => {
    const endpoint = documented(
      PUBLIC_API_ENDPOINTS,
      "GET",
      "/api/packages/:slug",
    );

    expect(() =>
      v.parse(PackageResponseSchema, JSON.parse(endpoint.response).package),
    ).not.toThrow();
  });

  test("the documented package booking is one the endpoint would accept", () => {
    const endpoint = documented(
      PUBLIC_API_ENDPOINTS,
      "POST",
      "/api/packages/:slug/book",
    );

    expect(() =>
      v.parse(PackageBookRequestSchema, JSON.parse(endpoint.request!)),
    ).not.toThrow();
  });

  test("the documented booking chooses add-ons the package really offers", () => {
    // The endpoint checks each selection against the parent's real children,
    // and the fold wants each member's add-ons to add up to how many of that
    // member the order books — so a booking that asks for the wrong number, or
    // for something the package does not publish, would be refused.
    const pkg = documentedPackage();
    const booking = documentedBooking();
    const chosen = booking.children as Selection[];

    expect(chosen.length).toBeGreaterThan(0);
    for (const member of pkg.members as PackageMember[]) {
      const offered = new Map(
        (member.children ?? []).map((child) => [child.slug, child]),
      );
      const forMember = chosen.filter(({ parent }) => parent === member.slug);
      if (offered.size === 0) {
        expect(forMember).toEqual([]);
        continue;
      }

      for (const { quantity, slug } of forMember) {
        const child = offered.get(slug);
        if (!child) {
          throw new Error(`The package has no ${slug} under ${member.slug}`);
        }
        expect(quantity).toBeLessThanOrEqual(child.maxPurchasable);
      }

      const picked = forMember.reduce((sum, one) => sum + one.quantity, 0);
      expect(picked).toBe(member.quantity * booking.quantity);
    }
  });

  test("the documented booking orders no more bundles than are for sale", () => {
    expect(documentedBooking().quantity).toBeLessThanOrEqual(
      documentedPackage().maxPurchasable,
    );
  });

  test("the documented booking picks a date and length the package offers", () => {
    // Only a package that publishes dates or day counts constrains these, and
    // the endpoint refuses a choice outside what it published.
    const pkg = documentedPackage();
    const booking = documentedBooking();

    if (pkg.availableDates) {
      expect(pkg.availableDates).toContain(booking.date);
    }
    if (pkg.dayCounts) {
      expect(
        (pkg.dayCounts as { days: number }[]).map(({ days }) => days),
      ).toContain(booking.dayCount);
    }
  });

  test("the documented booking fills in the fields the package asks for", () => {
    // The endpoint checks the booking against the package's merged contact
    // fields, so a booking missing one of them is refused.
    const booking = documentedBooking();

    for (const field of documentedPackage().fields.split(",")) {
      expect(booking).toHaveProperty(field);
    }
  });
});
