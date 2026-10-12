/** validateForm's declared number ranges: a field's `min` and `max` bounds
 *  the parsed value on the server, the same bounds the browser applies. */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";
import { validateForm } from "#shared/forms/validation.ts";
import { field } from "#test-utils/field.ts";

// jscpd:ignore-end

describe("validateForm declared number ranges", () => {
  beforeAll(() => ensureMessageGroups(["validation"]));

  const quantityFields: Field[] = [
    field({
      label: "Qty",
      min: 1,
      name: "qty",
      required: true,
      type: "number",
    }),
  ];

  test("rejects a number below the declared min", () => {
    expect(validateForm(new FormParams({ qty: "0" }), quantityFields)).toEqual({
      error: "Qty must be 1 or greater",
      valid: false,
    });
  });

  test("accepts a number at the declared min", () => {
    const result = validateForm(new FormParams({ qty: "1" }), quantityFields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.qty).toBe(1);
  });

  test("rejects a number above the declared max and accepts the max", () => {
    const fields: Field[] = [
      field({ label: "Count", max: 90, name: "count", type: "number" }),
    ];
    expect(validateForm(new FormParams({ count: "91" }), fields)).toEqual({
      error: "Count must be 90 or fewer",
      valid: false,
    });
    const result = validateForm(new FormParams({ count: "90" }), fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.count).toBe(90);
  });

  test("accepts zero when the declared min is zero", () => {
    const fields: Field[] = [
      field({ label: "Booked", min: 0, name: "booked", type: "number" }),
    ];
    const result = validateForm(new FormParams({ booked: "0" }), fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.booked).toBe(0);
  });

  test("leaves a number field without bounds unbounded", () => {
    const fields: Field[] = [
      field({ label: "Count", name: "count", type: "number" }),
    ];
    const result = validateForm(new FormParams({ count: "-5" }), fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.count).toBe(-5);
  });

  test("returns null for an empty optional number with a min", () => {
    const fields: Field[] = [
      field({
        label: "Min tickets",
        min: 1,
        name: "min_tickets",
        type: "number",
      }),
    ];
    const result = validateForm(new FormParams({ min_tickets: "" }), fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.min_tickets).toBeNull();
  });

  test("enforces the min on a field parser that returns a number", () => {
    const fields: Field[] = [
      field({
        label: "Visits",
        min: 0,
        name: "visits",
        parse: (value: string) => (value ? Number(value) : 0),
        type: "number",
      }),
    ];
    expect(validateForm(new FormParams({ visits: "-1" }), fields)).toEqual({
      error: "Visits must be 0 or greater",
      valid: false,
    });
  });
});
