import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { builderForm } from "#templates/fields/builder.ts";

describe("builder form", () => {
  test("offers the site name, provider choices, and both db boxes", () => {
    const names = builderForm.fields.map((field) => field.name);
    expect(names).toContain("site_name");
    expect(names).toContain("db_url");
    expect(names).toContain("db_token");
    const name = builderForm.fields[0]!;
    expect(name.required).toBe(true);
    expect(name.maxlength).toBe(64);
    expect(name.minlength).toBe(1);
  });

  test("renders every provider choice with the value its route reads", () => {
    const html = builderForm.render();
    for (const value of ["bunny", "turso", "manual"]) {
      expect(html).toContain(`value="${value}"`);
    }
    // The name box refuses to submit empty, so the route never sees "".
    expect(html).toContain('name="site_name"');
  });
});
