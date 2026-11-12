// The shared site-page input mapping's field refusals, tested directly so the
// JSON API suites keep the request path to themselves.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { toPageWrite } from "#routes/admin/api-site-pages-input.ts";

test("toPageWrite refuses a non-string slug with the field message", () => {
  expect(toPageWrite({ name: "Visit", slug: 7 }, null)).toEqual({
    error: "slug must be a string",
    ok: false,
  });
});
