/** Which listing and group fields each writer cannot set. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import {
  LISTING_FIELDS,
  LISTING_LINK_KEYS,
  LISTING_WRITE_KEYS,
} from "#shared/records/listing-fields.ts";
import {
  type ClosedReason,
  closedFields,
  type WriteAccess,
} from "#shared/rest/field-specs.ts";

/** A writer on a site with the given features off and the given locks on. */
const accessOf = (
  off: readonly ("attributes" | "builder" | "logistics" | "subscriptions")[],
  on: readonly ("demo" | "editor" | "nonOwner")[],
): WriteAccess => ({
  features: {
    attributes: !off.includes("attributes"),
    builder: !off.includes("builder"),
    logistics: !off.includes("logistics"),
    subscriptions: !off.includes("subscriptions"),
  },
  locks: {
    demo: on.includes("demo"),
    editor: on.includes("editor"),
    nonOwner: on.includes("nonOwner"),
  },
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

describe("the listing link keys", () => {
  test("only attribute options need a feature, and only an owner assigns them", () => {
    expect(LISTING_LINK_KEYS).toEqual([
      {
        feature: "attributes",
        key: "attribute_option_ids",
        lockedFor: ["nonOwner"],
      },
      { key: "child_listing_ids" },
      { key: "group_ids" },
    ]);
  });

  test("the write keys are the fields, then the link keys", () => {
    expect(LISTING_WRITE_KEYS).toEqual([
      ...LISTING_FIELDS,
      ...LISTING_LINK_KEYS,
    ]);
  });

  test("attributes off closes the attribute options for an owner", () => {
    expect([
      ...closedFields(LISTING_WRITE_KEYS, accessOf(["attributes"], [])),
    ]).toEqual([["attribute_option_ids", "attributes"]]);
  });

  test("the feature that is off is the reason before the owner-only rule", () => {
    expect([
      ...closedFields(
        LISTING_WRITE_KEYS,
        accessOf(["attributes"], ["nonOwner"]),
      ),
    ]).toEqual([["attribute_option_ids", "attributes"]]);
  });

  test("a manager cannot set the attribute options on a site with every feature on", () => {
    expect([
      ...closedFields(LISTING_WRITE_KEYS, accessOf([], ["nonOwner"])),
    ]).toEqual([["attribute_option_ids", "nonOwner"]]);
  });
});
