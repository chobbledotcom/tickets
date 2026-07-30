import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { getGroupCreateForm, getGroupForm } from "#templates/fields/group.ts";
import { allEnglishMessages } from "#test-utils/i18n.ts";

await allEnglishMessages();

describe("group fields", () => {
  test("the create form has every field in order, with no slug", () => {
    const form = getGroupCreateForm();
    expect(form.fields.map((f) => f.name)).toEqual([
      "name",
      "description",
      "max_attendees",
      "terms_and_conditions",
      "hidden",
      "is_package",
      "hide_package_listings",
    ]);
  });

  test("the edit form is the create form with the slug in second place", () => {
    const form = getGroupForm();
    expect(form.fields.map((f) => f.name)).toEqual([
      "name",
      "slug",
      "description",
      "max_attendees",
      "terms_and_conditions",
      "hidden",
      "is_package",
      "hide_package_listings",
    ]);
  });

  test("the name is required text and max attendees is a number box", () => {
    const form = getGroupCreateForm();
    expect(form.fields[0]).toMatchObject({
      name: "name",
      required: true,
      type: "text",
    });
    expect(form.fields[2]).toMatchObject({
      name: "max_attendees",
      type: "number",
    });
  });

  test("the package checkboxes each offer exactly one tick worth 1", () => {
    const form = getGroupCreateForm();
    const isPackage = form.fields.find((f) => f.name === "is_package");
    const hideListings = form.fields.find(
      (f) => f.name === "hide_package_listings",
    );
    expect(isPackage).toMatchObject({
      options: [{ label: "Sell this group as a package", value: "1" }],
      type: "checkbox-group",
    });
    expect(hideListings?.type).toBe("checkbox-group");
    expect(
      (hideListings as { options: { value: string }[] }).options.map(
        (o) => o.value,
      ),
    ).toEqual(["1"]);
  });

  test("terms are a markdown textarea that rejects only over-long text", () => {
    const form = getGroupCreateForm();
    const terms = form.fields.find((f) => f.name === "terms_and_conditions");
    expect(terms).toMatchObject({
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      type: "textarea",
    });
    const validate = (terms as { validate: (v: string) => string | null })
      .validate;
    expect(validate("fine")).toBeNull();
    expect(validate("a".repeat(MAX_TEXTAREA_LENGTH))).toBeNull();
    expect(validate("a".repeat(MAX_TEXTAREA_LENGTH + 1))).toContain(
      String(MAX_TEXTAREA_LENGTH),
    );
  });
});
