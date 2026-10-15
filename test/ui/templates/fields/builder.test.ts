import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { builderForm } from "#templates/fields/builder.ts";
import { byName } from "#test-utils/fields.ts";
import { has, says } from "#test-utils/says.ts";

describe("builder form", () => {
  test("offers the site name, provider choices, and both db boxes", () => {
    const names = builderForm.fields.map((field) => field.name);
    has(names, "site_name");
    has(names, "db_url");
    has(names, "db_token");
    const name = byName(builderForm.fields, "site_name");
    expect(name.required).toBe(true);
    expect(name.maxlength).toBe(MAX_INPUT_LENGTH);
    expect(name.minlength).toBe(1);
  });

  test("caps the pasted database token at the machine-credential limit", () => {
    const token = byName(builderForm.fields, "db_token");
    // A libsql auth token is pasted, like the wallet PEM keys — its cap is
    // the shared textarea one, not the single-line rule.
    expect(token.maxlength).toBe(MAX_TEXTAREA_LENGTH);
  });

  test("renders every provider choice with the value its route reads", () => {
    const html = builderForm.render();
    for (const value of ["bunny", "turso", "manual"]) {
      says(html, `value="${value}"`);
    }
    // Bunny appears once per choice list — database and hosting — and both
    // must carry the value, or one route arm reads nothing.
    expect(html.match(/value="bunny"/g)).toHaveLength(2);
    // The name box refuses to submit empty, so the route never sees "".
    says(html, 'name="site_name"');
  });
});
