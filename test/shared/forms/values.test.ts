import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Field } from "#shared/forms/field.ts";
import { entityToFieldValues } from "#shared/forms/values.ts";

const field = (
  overrides: Partial<Field> & { name: string; label: string },
): Field => ({ type: "text", ...overrides }) as Field;

describe("entityToFieldValues", () => {
  const fields = [
    field({ label: "A", name: "a" }),
    field({ label: "B", name: "b" }),
  ];

  test("derives field values from the entity", () => {
    const values = entityToFieldValues({ a: "1", b: "2" }, fields, {});
    expect(values).toEqual({ a: "1", b: "2" });
  });

  test("applies a formatter when one is supplied for the field", () => {
    const values = entityToFieldValues({ a: "1", b: "2" }, fields, {
      a: (e) => `formatted-${e.a}`,
    });
    expect(values.a).toBe("formatted-1");
    expect(values.b).toBe("2");
  });

  test("yields empty strings when there is no entity", () => {
    const values = entityToFieldValues(undefined, fields, {});
    expect(values).toEqual({ a: "", b: "" });
  });

  test("merges extra values over the entity-derived fields", () => {
    const values = entityToFieldValues(
      { a: "1", b: "2" },
      fields,
      {},
      {
        b: "override",
        c: "extra",
      },
    );
    expect(values.a).toBe("1");
    expect(values.b).toBe("override");
    expect(values.c).toBe("extra");
  });

  /** One yes/no box, shaped as the real forms build them. */
  const yesNoBox = field({
    label: "Tick this",
    name: "keep",
    options: [{ label: "Keep it", value: "1" }],
    type: "checkbox-group",
  });

  test("a stored boolean fills its yes/no box with the tick it carries", () => {
    expect(entityToFieldValues({ keep: true }, [yesNoBox], {})).toEqual({
      keep: "1",
    });
    expect(entityToFieldValues({ keep: false }, [yesNoBox], {})).toEqual({
      keep: "",
    });
  });

  test("a stored boolean picks the yes option of its yes/no dropdown", () => {
    const yesNoSelect = field({
      label: "Keep it",
      name: "keep",
      options: [
        { label: "No", value: "" },
        { label: "Yes", value: "1" },
      ],
      type: "select",
    });
    expect(entityToFieldValues({ keep: true }, [yesNoSelect], {})).toEqual({
      keep: "1",
    });
    expect(entityToFieldValues({ keep: false }, [yesNoSelect], {})).toEqual({
      keep: "",
    });
  });

  test("a stored boolean keeps its own text when the box is not yes/no", () => {
    // The number box has no tick to draw, so the raw value stays as text.
    expect(entityToFieldValues({ a: true }, [fields[0]!], {})).toEqual({
      a: "true",
    });
  });
});
