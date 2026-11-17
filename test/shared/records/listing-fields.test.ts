/** Which listing and group fields each writer cannot set. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
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
  ["useDefaults", "editor"],
  ["webhookUrl", "editor"],
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
      ["assignBuiltSite", "builder"],
      ["initialSiteMonths", "builder"],
      ["monthsPerUnit", "builder"],
    ],
  ],
  [
    "logistics off closes the logistics switch",
    accessOf(["logistics"], []),
    [["usesLogistics", "logistics"]],
  ],
  [
    "subscriptions off closes the recurring offer fields",
    accessOf(["subscriptions"], []),
    [
      ["recurringInterval", "subscriptions"],
      ["recurringPrice", "subscriptions"],
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
    [["webhookUrl", "demo"]],
  ],
  [
    "the demo lock names the reason first for an editor in the demo",
    accessOf([], ["demo", "editor"]),
    [...EDITOR_CLOSED.slice(0, 2), ["webhookUrl", "demo"]],
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
        key: "attributeOptionIds",
        lockedFor: ["nonOwner"],
      },
      { key: "childListingIds" },
      { key: "groupIds" },
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
    ]).toEqual([["attributeOptionIds", "attributes"]]);
  });

  test("the feature that is off is the reason before the owner-only rule", () => {
    expect([
      ...closedFields(
        LISTING_WRITE_KEYS,
        accessOf(["attributes"], ["nonOwner"]),
      ),
    ]).toEqual([["attributeOptionIds", "attributes"]]);
  });

  test("a manager cannot set the attribute options on a site with every feature on", () => {
    expect([
      ...closedFields(LISTING_WRITE_KEYS, accessOf([], ["nonOwner"])),
    ]).toEqual([["attributeOptionIds", "nonOwner"]]);
  });
});

/* jscpd:ignore-start -- a list of strings, not code */
const DEFAULTS_AND_FLOORS = [
  "active: stores true",
  `bookableDays: stores ${JSON.stringify(VALID_DAY_NAMES)}`,
  "durationDays: stores 1",
  'fields: stores "email"',
  "initialSiteMonths: stores 0, from 0",
  'listingType: stores "standard"',
  "maxAttendees: stores undefined, from 1",
  "maximumDaysAfter: stores 90, from 0",
  "maxPrice: stores 0",
  "maxQuantity: stores 1, from 1",
  "minimumDaysBefore: stores 1, from 0",
  "minQuantity: stores 1, from 1",
  "monthsPerUnit: stores 0, from 0",
  'recurringInterval: stores ""',
  "recurringPrice: stores 0",
  "unitPrice: stores 0",
];
/* jscpd:ignore-end */

test("each listing field that names a stored default or a smallest count names this one", () => {
  const declared = LISTING_FIELDS.flatMap((field) => {
    const { default: stored, min } = {
      default: undefined,
      min: undefined,
      ...field,
    };
    if (stored === undefined && min === undefined) return [];
    const floor = min === undefined ? "" : `, from ${min}`;
    return [`${field.key}: stores ${JSON.stringify(stored)}${floor}`];
  });

  expect(declared).toEqual(DEFAULTS_AND_FLOORS);
});

/* jscpd:ignore-start -- a list of strings, not code */
const LISTING_KEYS = [
  "active",
  "assignBuiltSite",
  "bookableAlone",
  "bookableDays",
  "canPayMore",
  "closesAt",
  "customisableDays",
  "date",
  "dayPrices",
  "description",
  "durationDays",
  "fields",
  "hidden",
  "initialSiteMonths",
  "listingType",
  "location",
  "maxAttendees",
  "maximumDaysAfter",
  "maxPrice",
  "maxQuantity",
  "minimumDaysBefore",
  "minQuantity",
  "monthsPerUnit",
  "name",
  "nonTransferable",
  "purchaseOnly",
  "recurringInterval",
  "recurringPrice",
  "thankYouUrl",
  "unitPrice",
  "useDefaults",
  "usesLogistics",
  "webhookUrl",
];
/* jscpd:ignore-end */

test("the listing fields name these keys, in this order", () => {
  expect(LISTING_FIELDS.map((field) => field.key)).toEqual(LISTING_KEYS);
});
