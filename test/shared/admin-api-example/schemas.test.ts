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

  test("a bundle names each of its parts once", () => {
    const pkg = bundle();

    refuses(PackageResponseSchema, {
      ...pkg,
      members: [...pkg.members, pkg.members[0]],
    });
  });
});
