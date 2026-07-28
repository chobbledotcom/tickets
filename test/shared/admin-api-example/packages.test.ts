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
    slug: string;
    children?: { maxPurchasable: number; slug: string }[];
  };

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
    // The endpoint checks each selection against the parent's real children, so
    // a booking naming a child the package does not publish, or asking for more
    // than that child can supply, would be refused.
    type Child = { maxPurchasable: number; slug: string };
    const members = documentedPackage().members as PackageMember[];
    const offered = new Map<string, Map<string, Child>>(
      members.map((member) => [
        member.slug,
        new Map<string, Child>(
          (member.children ?? []).map((child) => [child.slug, child]),
        ),
      ]),
    );

    const chosen = documentedBooking().children as {
      parent: string;
      quantity: number;
      slug: string;
    }[];

    expect(chosen.length).toBeGreaterThan(0);
    for (const { parent, quantity, slug } of chosen) {
      const child = offered.get(parent)?.get(slug);
      if (!child) throw new Error(`The package has no ${slug} under ${parent}`);
      expect(quantity).toBeLessThanOrEqual(child.maxPurchasable);
    }
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
