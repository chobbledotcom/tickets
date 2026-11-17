import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/message-groups.generated.ts";
import type { ClosedReason } from "#shared/rest/field-specs.ts";
import {
  getListingEditForm,
  getListingForm,
  type ListingFormView,
} from "#templates/fields/listing.ts";
import {
  LISTING_FIELDS,
  SLUG_FIELD,
} from "#test/ui/templates/fields/listing/expected-fields.ts";
import { fieldShape as shape } from "#test-utils/field-shape.ts";

// The builders resolve their copy while building, so the catalog must be in
// place before any field list is read — as the admin shell guarantees.
await ensureMessageGroups(MESSAGE_GROUPS);

/** The declared fields with just the named boxes shown or hidden — what a
 * view is expected to change, and nothing else. */
const withVisibility =
  (visible: boolean) =>
  (names: string[]): Record<string, unknown>[] =>
    LISTING_FIELDS.map((field) =>
      names.includes(field.name) ? { ...field, visible } : field,
    );
const revealing = withVisibility(true);
const hiding = withVisibility(false);

const BUILT_SITE_BOXES = [
  "monthsPerUnit",
  "initialSiteMonths",
  "assignBuiltSite",
];

const RECURRING_BOXES = ["recurringPrice", "recurringInterval"];

const boxesOf = (names: string[], reason: ClosedReason) =>
  names.map((name): [string, ClosedReason] => [name, reason]);

/** The boxes a site closes for each feature it turns off. */
const FEATURE_BOXES: [string, ClosedReason][] = [
  ...boxesOf(BUILT_SITE_BOXES, "builder"),
  ["usesLogistics", "logistics"],
  ...boxesOf(RECURRING_BOXES, "subscriptions"),
];

/** The served fields of a form with the given features off and the given
 * extra boxes closed. */
const servedWith = (
  off: ClosedReason[],
  view: Omit<Partial<ListingFormView>, "closed"> = {},
  ...extra: [string, ClosedReason][]
) =>
  getListingForm({
    closed: new Map([
      ...FEATURE_BOXES.filter(([, reason]) => off.includes(reason)),
      ...extra,
    ]),
    ...view,
  }).fields.map(shape);

const FEATURES_OFF: ClosedReason[] = ["builder", "logistics", "subscriptions"];

describe("listing field schemas", () => {
  test("with site building, logistics and subscriptions off, the listing form serves exactly its declared fields", () => {
    expect(servedWith(FEATURES_OFF)).toEqual(LISTING_FIELDS);
  });

  test("each feature turned on reveals only its own boxes", () => {
    expect([
      servedWith([]),
      servedWith(["builder", "subscriptions"]),
      servedWith(["logistics", "subscriptions"]),
      servedWith(["builder", "logistics"]),
    ]).toEqual([
      revealing([...BUILT_SITE_BOXES, "usesLogistics", ...RECURRING_BOXES]),
      revealing(["usesLogistics"]),
      revealing(BUILT_SITE_BOXES),
      revealing(RECURRING_BOXES),
    ]);
  });

  test("the storage view only reveals the image box", () => {
    expect(servedWith(FEATURES_OFF, { storage: true })).toEqual(
      revealing(["attachment"]),
    );
  });

  test("closing the webhook hides only the webhook box", () => {
    expect(servedWith(FEATURES_OFF, {}, ["webhookUrl", "editor"])).toEqual(
      hiding(["webhookUrl"]),
    );
  });

  test("the autofocus view puts the cursor in the name box and changes nothing else", () => {
    const focused = LISTING_FIELDS.map((field) =>
      field.name === "name" ? { autofocus: true, ...field } : field,
    );
    expect(servedWith(FEATURES_OFF, { nameAutofocus: true })).toEqual(focused);
  });

  test("the edit form is the listing form plus the slug box", () => {
    expect(
      getListingEditForm({
        closed: new Map(FEATURE_BOXES),
      }).fields.map(shape),
    ).toEqual([...LISTING_FIELDS, SLUG_FIELD]);
  });
});
