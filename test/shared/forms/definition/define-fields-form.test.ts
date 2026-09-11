import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resetI18nForTest, t } from "#i18n";
import { FormParams } from "#shared/form-data.ts";
import { defineFieldsForm, type FormValues } from "#shared/forms/definition.ts";
import { withEnv } from "#test-utils/env.ts";

describe("defineFieldsForm", () => {
  const getLabelForm = defineFieldsForm(
    () => [{ label: t("common.name"), name: "name", type: "text" }] as const,
  );

  test("builds a fresh form whose labels follow the active request", () => {
    const labelWith = (replacement: string): string => {
      using _env = withEnv({ I18N_REPLACEMENTS: `name|${replacement}` });
      resetI18nForTest();
      return getLabelForm().render();
    };
    try {
      expect(labelWith("Nickname")).toContain("Nickname");
    } finally {
      resetI18nForTest();
    }
    expect(getLabelForm().render()).toContain("Name");
  });

  test("passes the caller's arguments through to the fields builder", () => {
    const getViewForm = defineFieldsForm(
      (count: number) =>
        [
          { label: `Visitors ${count}`, name: "count", type: "number" },
        ] as const,
    );
    expect(getViewForm(3).render()).toContain("Visitors 3");
  });

  test("keeps the field types the FormValues type reads", () => {
    const getAgeForm = defineFieldsForm(
      () =>
        [
          {
            label: "Age",
            name: "age",
            parse: (value: string) => Number(value),
            required: true,
            type: "number",
          },
        ] as const,
    );
    type AgeValues = FormValues<ReturnType<typeof getAgeForm>>;
    const readAge = (values: AgeValues): number => values.age;

    const result = getAgeForm().validate(new FormParams({ age: "25" }));
    expect(result.valid).toBe(true);
    if (result.valid) expect(readAge(result.values)).toBe(25);
  });
});
