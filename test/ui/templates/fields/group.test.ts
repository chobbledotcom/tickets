import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
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
      "maxAttendees",
      "termsAndConditions",
      "hidden",
      "isPackage",
      "hidePackageListings",
      "scanChecksInAllListings",
      "showHiddenListings",
    ]);
  });

  test("the edit form is the create form with the slug in second place", () => {
    const form = getGroupForm();
    expect(form.fields.map((f) => f.name)).toEqual([
      "name",
      "slug",
      "description",
      "maxAttendees",
      "termsAndConditions",
      "hidden",
      "isPackage",
      "hidePackageListings",
      "scanChecksInAllListings",
      "showHiddenListings",
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
      defaultValue: "0",
      name: "maxAttendees",
      required: true,
      type: "number",
    });
  });

  test("refuses a blank max attendees box instead of reading it as 0", () => {
    const form = getGroupCreateForm();
    const blank = new FormParams({
      description: "",
      maxAttendees: "",
      name: "Example group",
    });
    expect(form.validate(blank)).toEqual({
      error: "Max attendees is required",
      valid: false,
    });
    const zero = new FormParams({
      description: "",
      maxAttendees: "0",
      name: "Example group",
    });
    expect(form.validate(zero).valid).toBe(true);
  });

  test("the package checkboxes each offer exactly one tick worth 1", () => {
    const form = getGroupCreateForm();
    const isPackage = form.fields.find((f) => f.name === "isPackage");
    const hideListings = form.fields.find(
      (f) => f.name === "hidePackageListings",
    );
    const showHidden = form.fields.find((f) => f.name === "showHiddenListings");
    expect(isPackage).toMatchObject({
      options: [{ label: "Sell this group as a package", value: "1" }],
      type: "checkbox-group",
    });
    expect(hideListings).toMatchObject({
      options: [{ value: "1" }],
      type: "checkbox-group",
    });
    expect(showHidden).toMatchObject({
      options: [{ label: "Show hidden listings on this group's booking page" }],
    });
  });

  test("terms are a markdown textarea that rejects only over-long text", () => {
    const form = getGroupCreateForm();
    const terms = form.fields.find((f) => f.name === "termsAndConditions");
    expect(terms).toMatchObject({
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      type: "textarea",
    });
    const validate = (terms as { validate: (v: string) => string | null })
      .validate;
    expect(validate("fine")).toBeNull();
    expect(validate("a".repeat(MAX_TEXTAREA_LENGTH))).toBeNull();
    assertStringIncludes(
      validate("a".repeat(MAX_TEXTAREA_LENGTH + 1)) ?? "",
      String(MAX_TEXTAREA_LENGTH),
    );
  });
});
