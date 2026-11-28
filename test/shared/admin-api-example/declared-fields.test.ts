import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { DECLARED_FIELDS } from "#shared/admin-api-example/declared-fields.ts";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";

const ID_LIST = { form: "list_of", of: { form: "whole_number", min: 1 } };
const UPDATE_SLUG = { only: "update", value: { form: "text" } };

describe("declared write fields", () => {
  test("each resource with a field list names that list", () => {
    const lists = Object.entries(DECLARED_FIELDS).map(([path, declared]) => [
      path,
      declared.fields,
    ]);

    expect(lists).toEqual([
      ["attendee-statuses", STATUS_FIELDS],
      ["groups", GROUP_FIELDS],
      ["listings", LISTING_FIELDS],
    ]);
  });

  test("a listing links its groups, its add-ons, and its attribute options by id", () => {
    expect(DECLARED_FIELDS.listings?.extras).toEqual({
      attribute_option_ids: { value: ID_LIST },
      child_listing_ids: { value: ID_LIST },
      group_ids: { value: ID_LIST },
      slug: UPDATE_SLUG,
    });
  });

  test("a group names each package member by the keys of one member", () => {
    expect(DECLARED_FIELDS.groups?.extras).toEqual({
      package_members: {
        value: {
          form: "list_of",
          of: {
            form: "object",
            names: ["day_prices", "listing_id", "price", "quantity"],
          },
        },
      },
      slug: UPDATE_SLUG,
    });
  });

  test("a status takes no key outside its list", () => {
    expect(DECLARED_FIELDS["attendee-statuses"]?.extras).toEqual({});
  });
});
