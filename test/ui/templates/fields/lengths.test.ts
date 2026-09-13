import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";
import { renderField } from "#shared/forms/rendering.tsx";
import { validateForm } from "#shared/forms/validation.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { getAddAttendeeFields } from "#templates/fields/add-attendee.ts";
import {
  getChangePasswordForm,
  getLoginForm,
  getSetupForm,
} from "#templates/fields/admin.ts";
import { getTicketFields } from "#templates/fields/ticket.ts";
import { PHONE_FIELD_LENGTH } from "#templates/fields/validators.ts";

describe("form length boundaries", () => {
  const contactFields = "email,phone,address,special_instructions";
  const expectAccepts = (field: Field, value: string): void => {
    expect(
      validateForm(new FormParams({ [field.name]: value }), [field]),
    ).toEqual({ valid: true, values: { [field.name]: value } });
  };
  for (const [label, fields] of [
    ["public", getTicketFields(contactFields, false)],
    ["admin", getAddAttendeeFields(contactFields, false)],
  ] as const) {
    for (const field of fields.filter((field) =>
      ["name", "email", "phone", "address", "special_instructions"].includes(
        field.name,
      ),
    )) {
      const max =
        field.name === "phone" ? PHONE_FIELD_LENGTH : MAX_INPUT_LENGTH;
      const labels: Record<string, string> = {
        address: "Address",
        email: "Email address",
        name: "Name",
        phone: "Phone number",
        special_instructions: "Special instructions",
      };
      const valueAt = (length: number): string =>
        field.name === "email"
          ? `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(length - 197)}.com`
          : "1".repeat(length);

      test(`${label} ${field.name} renders its length limit`, () => {
        expect(renderField(field, "")).toContain(`maxlength="${max}"`);
      });
      test(`${label} ${field.name} accepts its exact limit`, () => {
        expectAccepts(field, valueAt(max));
      });
      test(`${label} ${field.name} rejects one character over its limit`, () => {
        expect(
          validateForm(new FormParams({ [field.name]: valueAt(max + 1) }), [
            field,
          ]),
        ).toEqual({
          error: `${labels[field.name]} must be ${max} characters or fewer`,
          valid: false,
        });
      });
    }
  }

  const passwordFields: readonly Field[] = [
    ...getLoginForm().fields,
    ...getSetupForm().fields,
    ...getChangePasswordForm().fields,
  ];
  for (const field of passwordFields.filter(
    ({ type }) => type === "password",
  )) {
    const isNew = field.autocomplete === "new-password";
    test(`${field.name} accepts the maximum new password length`, () => {
      expectAccepts(field, "p".repeat(MAX_INPUT_LENGTH));
    });
    test(`${field.name} ${isNew ? "rejects" : "accepts"} a longer password`, () => {
      const value = "p".repeat(isNew ? MAX_INPUT_LENGTH + 1 : 1000);
      expect(
        validateForm(new FormParams({ [field.name]: value }), [field]),
      ).toEqual(
        isNew
          ? {
              error: `${field.label} must be ${MAX_INPUT_LENGTH} characters or fewer`,
              valid: false,
            }
          : { valid: true, values: { [field.name]: value } },
      );
    });
  }

  for (const maximum of [10_240, 51_200]) {
    const field: Field = {
      label: "Body",
      ...(maximum === 51_200 && { maxlength: maximum }),
      name: "body",
      type: "textarea",
    };
    test(`textarea accepts its ${maximum}-character boundary`, () => {
      const value = "x".repeat(maximum);
      expect(validateForm(new FormParams({ body: value }), [field])).toEqual({
        valid: true,
        values: { body: value },
      });
      expect(renderField(field, "")).toContain(`maxlength="${maximum}"`);
    });
    test(`textarea rejects one character beyond ${maximum}`, () => {
      expect(
        validateForm(new FormParams({ body: "x".repeat(maximum + 1) }), [
          field,
        ]),
      ).toEqual({
        error: `Body must be ${maximum} characters or fewer`,
        valid: false,
      });
    });
  }
});
