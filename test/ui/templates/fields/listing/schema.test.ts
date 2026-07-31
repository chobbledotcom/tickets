import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";
import {
  getListingEditForm,
  getListingForm,
  logisticsAgentForm,
} from "#templates/fields/listing.ts";
import {
  LISTING_FIELDS,
  SLUG_FIELD,
} from "#test/ui/templates/fields/listing/expected-fields.ts";
import { fieldShape as shape } from "#test-utils/field-shape.ts";

// The builders resolve their copy while building, so the catalog must be in
// place before any field list is read — as the admin shell guarantees.
await ensureMessageGroups(MESSAGE_GROUPS);

/** The declared fields with just the named boxes made visible — what a view
 * flag is expected to change, and nothing else. */
const revealing = (names: string[]): Record<string, unknown>[] =>
  LISTING_FIELDS.map((field) =>
    names.includes(field.name) ? { ...field, visible: true } : field,
  );

describe("listing field schemas", () => {
  test("the listing form serves exactly its declared fields", () => {
    expect(getListingForm().fields.map(shape)).toEqual(LISTING_FIELDS);
  });

  test("the logistics view only reveals the agent assignment box", () => {
    expect(getListingForm({ logistics: true }).fields.map(shape)).toEqual(
      revealing(["uses_logistics"]),
    );
  });

  test("the storage view only reveals the image box", () => {
    expect(getListingForm({ storage: true }).fields.map(shape)).toEqual(
      revealing(["attachment"]),
    );
  });

  test("the builder view only reveals the built-site boxes", () => {
    expect(getListingForm({ builder: true }).fields.map(shape)).toEqual(
      revealing([
        "months_per_unit",
        "initial_site_months",
        "assign_built_site",
      ]),
    );
  });

  test("the autofocus view puts the cursor in the name box and changes nothing else", () => {
    const focused = LISTING_FIELDS.map((field) =>
      field.name === "name" ? { autofocus: true, ...field } : field,
    );
    expect(getListingForm({ nameAutofocus: true }).fields.map(shape)).toEqual(
      focused,
    );
  });

  test("the edit form is the listing form plus the slug box", () => {
    expect(getListingEditForm().fields.map(shape)).toEqual([
      ...LISTING_FIELDS,
      SLUG_FIELD,
    ]);
  });

  test("the logistics agent form serves exactly its declared field", () => {
    expect(logisticsAgentForm.fields.map(shape)).toEqual([
      {
        label: "Agent name",
        name: "name",
        placeholder: "Van 1",
        required: true,
        type: "text",
      },
    ]);
  });
});
