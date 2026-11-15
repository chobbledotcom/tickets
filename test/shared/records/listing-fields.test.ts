/** Which listing and group fields each writer cannot set. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import {
  type ClosedReason,
  closedFields,
  type WriteAccess,
} from "#shared/rest/field-specs.ts";

/** A staff writer on a site with every feature on and no demo. */
const OPEN: WriteAccess = {
  demo: false,
  editor: false,
  features: { builder: true, logistics: true },
};

/** The closed fields of one writer, in declaration order. */
const closedOf = (
  fields: typeof GROUP_FIELDS | typeof LISTING_FIELDS,
  access: WriteAccess,
): [string, ClosedReason][] => [...closedFields(fields, access)];

describe("listing and group fields", () => {
  test("a staff writer on a site with every feature on can set every field", () => {
    expect([
      closedOf(LISTING_FIELDS, OPEN),
      closedOf(GROUP_FIELDS, OPEN),
    ]).toEqual([[], []]);
  });

  test("site building off closes its three listing fields", () => {
    expect(
      closedOf(LISTING_FIELDS, {
        ...OPEN,
        features: { builder: false, logistics: true },
      }),
    ).toEqual([
      ["assign_built_site", "builder"],
      ["initial_site_months", "builder"],
      ["months_per_unit", "builder"],
    ]);
  });

  test("logistics off closes the logistics switch", () => {
    expect(
      closedOf(LISTING_FIELDS, {
        ...OPEN,
        features: { builder: true, logistics: false },
      }),
    ).toEqual([["uses_logistics", "logistics"]]);
  });

  test("an editor cannot set the bookable state, the defaults switch, or the webhook", () => {
    expect(closedOf(LISTING_FIELDS, { ...OPEN, editor: true })).toEqual([
      ["active", "editor"],
      ["use_defaults", "editor"],
      ["webhook_url", "editor"],
    ]);
  });

  test("demo mode closes the webhook, and the demo lock names the reason first", () => {
    expect([
      closedOf(LISTING_FIELDS, { ...OPEN, demo: true }),
      closedOf(LISTING_FIELDS, { ...OPEN, demo: true, editor: true }),
    ]).toEqual([
      [["webhook_url", "demo"]],
      [
        ["active", "editor"],
        ["use_defaults", "editor"],
        ["webhook_url", "demo"],
      ],
    ]);
  });

  test("no writer is ever closed out of a group field", () => {
    expect(
      closedOf(GROUP_FIELDS, {
        demo: true,
        editor: true,
        features: { builder: false, logistics: false },
      }),
    ).toEqual([]);
  });
});
