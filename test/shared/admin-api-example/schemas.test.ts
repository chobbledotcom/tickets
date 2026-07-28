/**
 * The documentation checks are only worth anything if the shapes they measure
 * against refuse what the endpoints cannot send. These break a documented body
 * on purpose and expect the refusal.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { PUBLIC_API_ENDPOINTS } from "#shared/admin-api-example/public.ts";
import {
  AdminGroupSchema,
  PackageResponseSchema,
  PublicListingDetailSchema,
  PublicListingSchema,
} from "#test-utils/api-schemas.ts";
import { documented } from "./helpers.ts";

const listing = () =>
  JSON.parse(documented(PUBLIC_API_ENDPOINTS, "GET", "/api/listings").response)
    .listings[0];

const bundle = () =>
  JSON.parse(
    documented(PUBLIC_API_ENDPOINTS, "GET", "/api/packages/:slug").response,
  ).package;

/** Break a documented body the given way and expect the shape to refuse it. */
const refuses = (schema: v.GenericSchema, broken: unknown): void => {
  expect(() => v.parse(schema, broken)).toThrow();
};

/** The same body, whole, is expected to pass — so a refusal above is the rule
 * biting rather than the example being wrong to begin with. */
const accepts = (schema: v.GenericSchema, whole: unknown): void => {
  expect(() => v.parse(schema, whole)).not.toThrow();
};

/** The documented bundle, sold by the day instead of at one price. */
const bundlePricedByDay = (dayCounts: unknown) => {
  const { priceMinor: _, ...rest } = bundle();
  return { ...rest, dayCounts };
};

/** A package group as the admin API answers with it, with one member. */
const packageGroup = (member: unknown) => ({
  description: "",
  hidden: false,
  hide_package_listings: false,
  id: 3,
  is_package: true,
  max_attendees: 50,
  name: "Camping Weekend",
  package_members: [member],
  slug: "camping-weekend",
  terms_and_conditions: "",
});

const pricedMember = { listing_id: 7, price: 2500, quantity: 1 };

describe("the shapes the documentation is measured against", () => {
  test("a date nobody could book is not a date", () => {
    refuses(PublicListingSchema, {
      ...listing(),
      availableDates: ["20 Aug"],
    });
  });

  test("an add-on's dates are read as strictly as its parent's", () => {
    refuses(PublicListingDetailSchema, {
      ...listing(),
      children: [{ ...listing(), availableDates: ["20 Aug"] }],
    });
  });

  test("a listing sold by the unit has no day prices", () => {
    refuses(PublicListingSchema, {
      ...listing(),
      customisableDays: false,
      dayPrices: { 1: 1000 },
    });
  });

  test("a listing sold by the day always prices its days", () => {
    const daily = { ...listing(), customisableDays: true };
    delete daily.dayPrices;

    refuses(PublicListingSchema, daily);
  });

  test("a bundle may publish an add-on nobody can book right now", () => {
    // The endpoint publishes every active add-on, so a sold-out one appears
    // beside its siblings and the bundle stays on sale through them.
    const pkg = bundle();
    const [member] = pkg.members;
    const [child] = member.children;

    accepts(PackageResponseSchema, {
      ...pkg,
      members: [
        {
          ...member,
          children: [{ ...child, isSoldOut: true, maxPurchasable: 0 }],
        },
        ...pkg.members.slice(1),
      ],
    });
  });

  test("a bundle prices each length once", () => {
    accepts(
      PackageResponseSchema,
      bundlePricedByDay([
        { days: 2, priceMinor: 5500 },
        { days: 3, priceMinor: 7500 },
      ]),
    );
    refuses(
      PackageResponseSchema,
      bundlePricedByDay([
        { days: 2, priceMinor: 5500 },
        { days: 2, priceMinor: 7500 },
      ]),
    );
  });

  test("a member with no repriced spans leaves them out", () => {
    accepts(AdminGroupSchema, packageGroup(pricedMember));
    accepts(
      AdminGroupSchema,
      packageGroup({ ...pricedMember, day_prices: { 2: 4000 } }),
    );
    refuses(
      AdminGroupSchema,
      packageGroup({ ...pricedMember, day_prices: {} }),
    );
  });

  test("a bundle names each of its parts once", () => {
    const pkg = bundle();

    refuses(PackageResponseSchema, {
      ...pkg,
      members: [...pkg.members, pkg.members[0]],
    });
  });
});
