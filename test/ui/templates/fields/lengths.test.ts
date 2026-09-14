import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";
import { renderField } from "#shared/forms/rendering.tsx";
import { validateForm } from "#shared/forms/validation.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { getAddAttendeeFields } from "#templates/fields/add-attendee.ts";
import {
  getBuiltSiteForm,
  getChangePasswordForm,
  getLoginForm,
  getSetupForm,
} from "#templates/fields/admin.ts";
import { builderForm } from "#templates/fields/builder.ts";
import { getTicketFields } from "#templates/fields/ticket.ts";
import {
  CONTACT_TEXTAREA_LIMIT,
  PHONE_FIELD_LENGTH,
} from "#templates/fields/validators.ts";
import { byName } from "#test-utils/fields.ts";

describe("form length boundaries", () => {
  const contactFields = "email,phone,address,special_instructions";
  const expectAccepts = (field: Field, value: string): void => {
    expect(
      validateForm(new FormParams({ [field.name]: value }), [field]),
    ).toEqual({ valid: true, values: { [field.name]: value } });
  };
  const CONTACT_RULES: Record<string, { label: string; max: number }> = {
    address: { label: "Address", max: CONTACT_TEXTAREA_LIMIT },
    email: { label: "Email address", max: MAX_INPUT_LENGTH },
    name: { label: "Name", max: MAX_INPUT_LENGTH },
    phone: { label: "Phone number", max: PHONE_FIELD_LENGTH },
    special_instructions: {
      label: "Special instructions",
      max: CONTACT_TEXTAREA_LIMIT,
    },
  };
  for (const [label, fields] of [
    ["public", getTicketFields(contactFields, false)],
    ["admin", getAddAttendeeFields(contactFields, false)],
  ] as const) {
    for (const field of fields.filter((field) => field.name in CONTACT_RULES)) {
      const { label: fieldLabel, max } = CONTACT_RULES[field.name]!;
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
          error: `${fieldLabel} must be ${max} characters or fewer`,
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

  // The db_token is the one password-type field that declares its own cap:
  // it chooses a pasted machine credential (a libsql auth token), not a
  // login check, and a real token runs past the single-line limit.
  for (const [label, form] of [
    ["builder", builderForm],
    ["built-site", getBuiltSiteForm()],
  ] as const) {
    const token = byName(form.fields, "db_token");
    test(`${label} db_token renders the machine-credential cap`, () => {
      expect(renderField(token, "")).toContain(
        `maxlength="${MAX_TEXTAREA_LENGTH}"`,
      );
    });
    test(`${label} db_token accepts a real-sized token`, () => {
      expectAccepts(token, "t".repeat(MAX_TEXTAREA_LENGTH));
    });
    test(`${label} db_token rejects one character past the cap`, () => {
      expect(
        validateForm(
          new FormParams({ db_token: "t".repeat(MAX_TEXTAREA_LENGTH + 1) }),
          [token],
        ),
      ).toEqual({
        error: `Database token must be ${MAX_TEXTAREA_LENGTH} characters or fewer`,
        valid: false,
      });
    });
  }
});
