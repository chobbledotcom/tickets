import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { selectOptionsFromHtml } from "#test-utils/parents-gate/helpers.ts";

describe("selectOptionsFromHtml", () => {
  test("throws a named error when the select is absent", () => {
    // A guard against silent mis-slicing: when the HTML has no
    // `<select name="…">` matching `selectName`, the helper must throw a
    // message naming the missing select — not return a near-full-page string
    // sliced from `indexOf(...) === -1`. Callers like expectSelectOffers get
    // an immediate, readable signal instead of a misleading truthy slice.
    expect(() =>
      selectOptionsFromHtml("<p>no selects here</p>", "missing_field"),
    ).toThrow('No <select name="missing_field"> found in HTML');
  });

  test("ignores a non-select element that reuses the name", () => {
    // The lookup matches a `<select>` opening tag carrying `name`, not any
    // element with that name attribute — so an `<input name="…">` (or any
    // other tag) reusing the name must NOT mask a missing select: the helper
    // still throws, because no `<select name="…">` is present.
    expect(() =>
      selectOptionsFromHtml(
        '<input name="missing_field" value="0">',
        "missing_field",
      ),
    ).toThrow('No <select name="missing_field"> found in HTML');
  });
});
