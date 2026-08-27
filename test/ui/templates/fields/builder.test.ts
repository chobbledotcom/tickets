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
  });

  test("renders the provider wording from the catalog", () => {
    const html = builderForm.render();
    expect(html).toContain("Site name");
    expect(html).toContain("db_url");
  });
});
