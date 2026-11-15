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

/** A writer on a site with the given features off and the given locks on. */
const accessOf = (
  off: readonly ("builder" | "logistics" | "subscriptions")[],
  on: readonly ("demo" | "editor")[],
): WriteAccess => ({
  features: {
    builder: !off.includes("builder"),
    logistics: !off.includes("logistics"),
    subscriptions: !off.includes("subscriptions"),
  },
  locks: { demo: on.includes("demo"), editor: on.includes("editor") },
});

/** The closed fields of one writer, in declaration order. */
const closedOf = (
  fields: typeof GROUP_FIELDS | typeof LISTING_FIELDS,
  access: WriteAccess,
): [string, ClosedReason][] => [...closedFields(fields, access)];

const EDITOR_CLOSED: [string, ClosedReason][] = [
  ["active", "editor"],
  ["use_defaults", "editor"],
  ["webhook_url", "editor"],
];

const LISTING_CASES: [string, WriteAccess, [string, ClosedReason][]][] = [
  [
    "a staff writer on a site with every feature on can set every field",
    accessOf([], []),
    [],
  ],
  [
    "site building off closes its three listing fields",
    accessOf(["builder"], []),
    [
      ["assign_built_site", "builder"],
      ["initial_site_months", "builder"],
      ["months_per_unit", "builder"],
    ],
  ],
  [
    "logistics off closes the logistics switch",
    accessOf(["logistics"], []),
    [["uses_logistics", "logistics"]],
  ],
  [
    "subscriptions off closes the recurring offer fields",
    accessOf(["subscriptions"], []),
    [
      ["recurring_interval", "subscriptions"],
      ["recurring_price", "subscriptions"],
    ],
  ],
  [
    "an editor cannot set the bookable state, the defaults switch, or the webhook",
    accessOf([], ["editor"]),
    EDITOR_CLOSED,
  ],
  [
    "demo mode closes the webhook",
    accessOf([], ["demo"]),
    [["webhook_url", "demo"]],
  ],
  [
    "the demo lock names the reason first for an editor in the demo",
    accessOf([], ["demo", "editor"]),
    [...EDITOR_CLOSED.slice(0, 2), ["webhook_url", "demo"]],
  ],
];

describe("listing and group fields", () => {
  for (const [name, access, closed] of LISTING_CASES) {
    test(name, () => {
      expect(closedOf(LISTING_FIELDS, access)).toEqual(closed);
    });
  }

  test("no writer is ever closed out of a group field", () => {
    expect([
      closedOf(GROUP_FIELDS, accessOf([], [])),
      closedOf(
        GROUP_FIELDS,
        accessOf(["builder", "logistics"], ["demo", "editor"]),
      ),
    ]).toEqual([[], []]);
  });
});
