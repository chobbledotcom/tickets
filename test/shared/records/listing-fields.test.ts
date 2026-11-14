/** Which listing and group fields each door reads. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import { type Door, fieldsOnDoor } from "#shared/rest/field-specs.ts";

const keysOn = (
  fields: typeof GROUP_FIELDS | typeof LISTING_FIELDS,
  door: Door,
): string[] => fieldsOnDoor(fields, door).map((field) => field.key);

/** Each listing field in declaration order, with the doors that read it. */
/* jscpd:ignore-start -- a list of strings, not code */
const LISTING_DOORS: [string, string][] = [
  ["active", "api transfer"],
  ["assign_built_site", "transfer"],
  ["bookable_alone", "api form transfer"],
  ["bookable_days", "api transfer"],
  ["can_pay_more", "api form transfer"],
  ["closes_at", "api transfer"],
  ["customisable_days", "api form transfer"],
  ["date", "api transfer"],
  ["day_prices", "api transfer"],
  ["description", "api form transfer"],
  ["duration_days", "api form transfer"],
  ["fields", "api form transfer"],
  ["hidden", "api form transfer"],
  ["initial_site_months", "form transfer"],
  ["listing_type", "api transfer"],
  ["location", "api form transfer"],
  ["max_attendees", "api form transfer"],
  ["maximum_days_after", "api form transfer"],
  ["max_price", "api transfer"],
  ["max_quantity", "api form transfer"],
  ["minimum_days_before", "api form transfer"],
  ["min_quantity", "api form transfer"],
  ["months_per_unit", "form transfer"],
  ["name", "form transfer"],
  ["non_transferable", "api form transfer"],
  ["purchase_only", "form transfer"],
  ["thank_you_url", "api form transfer"],
  ["unit_price", "api transfer"],
  ["use_defaults", "api transfer"],
  ["uses_logistics", "transfer"],
  ["webhook_url", "api transfer"],
];
/* jscpd:ignore-end */

const DOORS: Door[] = ["api", "form", "transfer"];

/** The listing fields the table says one door reads, in table order. */
const listedFor = (door: Door): string[] =>
  LISTING_DOORS.filter(([, doors]) => doors.split(" ").includes(door)).map(
    ([key]) => key,
  );

describe("listing and group fields", () => {
  test("the JSON API, the listing form, and a transfer each read the listing fields the table names", () => {
    expect(DOORS.map((door) => keysOn(LISTING_FIELDS, door))).toEqual(
      DOORS.map(listedFor),
    );
  });

  test("a transfer carries every declared field", () => {
    expect([
      keysOn(LISTING_FIELDS, "transfer"),
      keysOn(GROUP_FIELDS, "transfer"),
    ]).toEqual([
      LISTING_FIELDS.map((field) => field.key),
      GROUP_FIELDS.map((field) => field.key),
    ]);
  });

  test("the group API and form read every group field but the name on the API", () => {
    expect([keysOn(GROUP_FIELDS, "api"), keysOn(GROUP_FIELDS, "form")]).toEqual(
      [
        GROUP_FIELDS.map((field) => field.key).filter((key) => key !== "name"),
        GROUP_FIELDS.map((field) => field.key),
      ],
    );
  });
});
