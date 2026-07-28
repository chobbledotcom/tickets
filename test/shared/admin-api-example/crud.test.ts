/**
 * The five admin CRUD endpoints are documented from one example record per
 * resource. These check the requests and answers around it agree with each
 * other and with what the endpoints really do.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  ADMIN_API_ENDPOINTS,
  type EndpointDoc,
} from "#shared/admin-api-example.ts";
import { listingCatalogFields } from "#shared/catalog-fields/fields.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { isOwnerRole } from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import {
  AdminGroupSchema,
  AdminListingSchema,
} from "#test-utils/api-schemas.ts";
import { documented, freshTotals, isBlank } from "./helpers.ts";

describe("documented admin CRUD endpoints", () => {
  test("the admin listing list also shows the groups a listing is in", () => {
    const listEndpoint = documented(
      ADMIN_API_ENDPOINTS,
      "GET",
      "/api/admin/listings",
    );
    const parsed = JSON.parse(listEndpoint.response);
    expect(() => v.parse(AdminListingSchema, parsed.listings[0])).not.toThrow();
  });

  /** The example a resource's endpoints show, paired with the delete body a
   * caller would have to send for it. */
  const documentedResources = (): {
    del: { confirm_identifier: string };
    example: { id: number; name: string };
    create: Record<string, unknown>;
    createResponse: Record<string, unknown>;
    update: Record<string, unknown>;
    updateResponse: Record<string, unknown>;
  }[] =>
    ["listings", "groups", "holidays"].map((plural) => {
      const singular = plural.slice(0, -1);
      const forPath = (method: string, suffix: string) =>
        documented(
          ADMIN_API_ENDPOINTS,
          method,
          `/api/admin/${plural}${suffix}`,
        );
      return {
        create: JSON.parse(forPath("POST", "").request!),
        createResponse: JSON.parse(forPath("POST", "").response)[singular],
        del: JSON.parse(forPath("DELETE", `/:${singular}Id`).request!),
        example: JSON.parse(forPath("GET", `/:${singular}Id`).response)[
          singular
        ],
        update: JSON.parse(forPath("PUT", `/:${singular}Id`).request!),
        updateResponse: JSON.parse(forPath("PUT", `/:${singular}Id`).response)[
          singular
        ],
      };
    });

  test("a create answers with the record as it was just stored", () => {
    for (const { create, createResponse, example } of documentedResources()) {
      // Everything the caller asked for comes back as they asked for it...
      for (const [field, value] of Object.entries(create)) {
        expect(createResponse[field]).toEqual(value);
      }
      // ...and nothing has been booked against it yet.
      for (const [field, value] of Object.entries(freshTotals(example))) {
        expect(createResponse[field]).toBe(value);
      }
    }
  });

  test("a created listing keeps the settings it is given by default", () => {
    // The create body says nothing about these, so the answer must show what
    // the stored defaults give it — not what the example record happens to
    // hold. Both are read from the column definitions themselves.
    const created = JSON.parse(
      documented(ADMIN_API_ENDPOINTS, "POST", "/api/admin/listings").response,
    ).listing;

    expect(created.bookable_days).toEqual([...VALID_DAY_NAMES]);
    expect(created.maximum_days_after).toBe(
      listingCatalogFields.maximumDaysAfter[4],
    );
  });

  test("an update answers with the record as it now reads", () => {
    for (const { example, update, updateResponse } of documentedResources()) {
      // Every field the update asked to change comes back changed, and the
      // rest of the record is unchanged.
      expect(updateResponse).toEqual({ ...example, ...update });
    }
  });

  test("each admin resource is returned under its own name", () => {
    const singleResponses = ADMIN_API_ENDPOINTS.filter(
      (e: EndpointDoc) => e.method === "GET" && e.path.includes(":"),
    ).map((e: EndpointDoc) => Object.keys(JSON.parse(e.response)));

    expect(singleResponses).toEqual([["listing"], ["group"], ["holiday"]]);
  });

  test("a delete answers with a plain ok", () => {
    const deletes = ADMIN_API_ENDPOINTS.filter(
      (e: EndpointDoc) => e.method === "DELETE",
    );

    expect(deletes.length).toBe(3);
    for (const endpoint of deletes) {
      expect(JSON.parse(endpoint.response)).toEqual({ status: "ok" });
    }
  });

  test("the listing list says which admin level is reading it", () => {
    const listEndpoint = documented(
      ADMIN_API_ENDPOINTS,
      "GET",
      "/api/admin/listings",
    );

    // The example is the owner's view, which sees every listing.
    expect(isOwnerRole(JSON.parse(listEndpoint.response).admin_level)).toBe(
      true,
    );
  });

  test("a delete example confirms the exact name of the thing it deletes", () => {
    // The real endpoints refuse a delete whose confirm_identifier is not the
    // stored name, so a documented pair that disagreed would be rejected.
    for (const { del, example } of documentedResources()) {
      expect(del.confirm_identifier).toBe(example.name);
    }
  });

  test("every documented example is a real, named, stored record", () => {
    for (const { example } of documentedResources()) {
      expect(isBlank(example.name)).toBe(false);
      // An id addresses a stored row and goes straight into a URL, so a
      // fractional one could never name the documented record.
      expect(Number.isSafeInteger(example.id)).toBe(true);
      expect(example.id).toBeGreaterThan(0);
    }
  });

  test("an update example only names fields it changes", () => {
    // A field set to the value the record already has teaches nothing, so
    // every field in an update example must differ from the example record.
    for (const { example, update } of documentedResources()) {
      // The two bodies are parsed separately, so compare by value rather than
      // by identity: two equal arrays are not the same object.
      const unchanged = Object.entries(update)
        .filter(
          ([key, value]) =>
            JSON.stringify(value) ===
            JSON.stringify((example as Record<string, unknown>)[key]),
        )
        .map(([key]) => key);

      expect(unchanged).toEqual([]);
      expect(Object.keys(update).length).toBeGreaterThan(0);
    }
  });

  test("the documented holiday runs from its start to its end", () => {
    const holiday = JSON.parse(
      documented(ADMIN_API_ENDPOINTS, "GET", "/api/admin/holidays/:holidayId")
        .response,
    ).holiday;

    expect(isIsoDate(holiday.start_date)).toBe(true);
    expect(isIsoDate(holiday.end_date)).toBe(true);
    // A holiday that ended before it began could never be saved.
    expect(holiday.end_date >= holiday.start_date).toBe(true);
  });

  test("the documented group shows every field a group carries", () => {
    const group = JSON.parse(
      documented(ADMIN_API_ENDPOINTS, "GET", "/api/admin/groups/:groupId")
        .response,
    ).group;

    expect(() => v.parse(AdminGroupSchema, group)).not.toThrow();
  });
});
