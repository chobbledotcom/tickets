import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/message-groups.generated.ts";
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

describe("listing field schemas", () => {
  test("the listing form serves exactly its declared fields", () => {
    expect(getListingForm().fields.map(shape)).toEqual(LISTING_FIELDS);
  });

  test("closing the logistics switch hides only the agent assignment box", () => {
    expect(
      getListingForm({
        closed: new Map([["uses_logistics", "logistics"]]),
      }).fields.map(shape),
    ).toEqual(hiding(["uses_logistics"]));
  });

  test("the storage view only reveals the image box", () => {
    expect(
      getListingForm({ closed: new Map(), storage: true }).fields.map(shape),
    ).toEqual(revealing(["attachment"]));
  });

  test("closing the site building fields hides only the built-site boxes", () => {
    expect(
      getListingForm({
        closed: new Map([
          ["assign_built_site", "builder"],
          ["initial_site_months", "builder"],
          ["months_per_unit", "builder"],
        ]),
      }).fields.map(shape),
    ).toEqual(
      hiding(["months_per_unit", "initial_site_months", "assign_built_site"]),
    );
  });

  test("closing the webhook hides only the webhook box", () => {
    expect(
      getListingForm({
        closed: new Map([["webhook_url", "editor"]]),
      }).fields.map(shape),
    ).toEqual(hiding(["webhook_url"]));
  });

  test("the autofocus view puts the cursor in the name box and changes nothing else", () => {
    const focused = LISTING_FIELDS.map((field) =>
      field.name === "name" ? { autofocus: true, ...field } : field,
    );
    expect(
      getListingForm({ closed: new Map(), nameAutofocus: true }).fields.map(
        shape,
      ),
    ).toEqual(focused);
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
