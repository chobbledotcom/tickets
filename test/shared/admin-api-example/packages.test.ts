/**
 * The package endpoints publish an example bundle and an example booking of it.
 * These check the pair describes one package a caller could really buy.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { PUBLIC_API_ENDPOINTS } from "#shared/admin-api-example/public.ts";
import { FormParams } from "#shared/form-data.ts";
import { tryValidateTicketFields } from "#templates/fields/ticket.ts";
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
    const pkg = documentedPackage();
    const booking = documentedBooking();
    const chosen = booking.children as Selection[];
    const members = pkg.members as PackageMember[];
    const offeredBy = new Map(
      members.map((member) => [
        member.slug,
        new Map((member.children ?? []).map((child) => [child.slug, child])),
      ]),
    );

    expect(chosen.length).toBeGreaterThan(0);
    // The endpoint refuses two entries for one add-on that disagree on price,
    // so each add-on under each member is chosen exactly once.
    const picks = chosen.map(({ parent, slug }) => `${parent}/${slug}`);
    expect(new Set(picks).size).toBe(picks.length);
    for (const { parent, quantity, slug } of chosen) {
      const offered = offeredBy.get(parent);
      if (!offered) throw new Error(`The package has no member ${parent}`);
      const child = offered.get(slug);
      if (!child) throw new Error(`The package has no ${slug} under ${parent}`);

      expect(Number.isSafeInteger(quantity)).toBe(true);
      expect(quantity).toBeGreaterThan(0);
      expect(quantity).toBeLessThanOrEqual(child.maxPurchasable);
    }

    for (const member of members) {
      const picked = chosen
        .filter(({ parent }) => parent === member.slug)
        .reduce((sum, one) => sum + one.quantity, 0);
      // Every member of the package is in the map, having been read from it.
      const offers = offeredBy.get(member.slug)!;
      // A member that publishes nothing to choose has nothing chosen for it.
      const wanted = offers.size ? member.quantity * booking.quantity : 0;

      expect(picked).toBe(wanted);
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

    // A package with no dates ignores one, so offering it in the example
    // documents a choice that does nothing.
    expect("date" in booking).toBe("availableDates" in pkg);
    expect("dayCount" in booking).toBe("dayCounts" in pkg);
    if (pkg.availableDates) {
      expect(pkg.availableDates).toContain(booking.date);
    }
    if (pkg.dayCounts) {
      expect(
        (pkg.dayCounts as { days: number }[]).map(({ days }) => days),
      ).toContain(booking.dayCount);
    }
  });

  test("the documented booking answers the package's questions acceptably", () => {
    // Run the example through the very checks the endpoint runs on a real
    // booking, so a phone number, address or email the endpoint would turn
    // away cannot be documented as one it takes.
    const form = new FormParams();
    for (const [field, value] of Object.entries(documentedBooking())) {
      if (typeof value === "string") form.set(field, value);
    }
    const refused = new Response(null, { status: 400 });

    const checked = tryValidateTicketFields(
      form,
      documentedPackage().fields,
      () => refused,
      false,
    );

    expect(checked).not.toBe(refused);
  });
});
