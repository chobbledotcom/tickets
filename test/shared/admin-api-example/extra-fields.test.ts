import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { EXTRA_FIELDS } from "#shared/admin-api-example/extra-fields.ts";

const ID_LIST = { form: "listOf", of: { form: "wholeNumber", min: 1 } };
const UPDATE_SLUG = { limits: [], only: "update", value: { form: "text" } };

describe("extra body keys", () => {
  test("a listing links its groups, its add-ons, and its attribute options by id", () => {
    expect(EXTRA_FIELDS.listings).toEqual({
      attribute_option_ids: { limits: ["owner"], value: ID_LIST },
      child_listing_ids: { limits: [], value: ID_LIST },
      group_ids: { limits: [], value: ID_LIST },
      slug: UPDATE_SLUG,
    });
  });

  test("a group names each package member by the keys of one member", () => {
    expect(EXTRA_FIELDS.groups).toEqual({
      package_members: {
        limits: [],
        value: {
          form: "listOf",
          of: {
            form: "object",
            names: ["day_prices", "listing_id", "price", "quantity"],
          },
        },
      },
      slug: UPDATE_SLUG,
    });
  });

  test("only listings and groups take extra body keys", () => {
    expect(Object.keys(EXTRA_FIELDS)).toEqual(["groups", "listings"]);
  });
});
