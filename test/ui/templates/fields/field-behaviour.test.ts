import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resetI18nForTest } from "#i18n";
import type { Field } from "#shared/forms/field.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import { getBuiltSiteForm } from "#templates/fields/admin.ts";
import { getListingAggregateFields } from "#templates/fields/aggregate.ts";
import { getGroupCreateForm } from "#templates/fields/group.ts";
import {
  getListingForm,
  logisticsAgentForm,
} from "#templates/fields/listing.ts";
import { getModifierForm } from "#templates/fields/modifier.ts";
import { getTicketFields } from "#templates/fields/ticket.ts";
import { getSlugField } from "#templates/fields/validators.ts";
import { withEnv } from "#test-utils/env.ts";
import { byName } from "#test-utils/fields.ts";

/** Run a field's `validate` (present on the fields under test here). */
const runValidate = (field: Field, value: string): string | null => {
  if (!field.validate) throw new Error(`"${field.name}" has no validate`);
  return field.validate(value);
};
const accepts = (field: Field, value: string) =>
  expect(runValidate(field, value)).toBeNull();
const rejects = (field: Field, value: string) =>
  expect(typeof runValidate(field, value)).toBe("string");

/** Run a field's `parse`. */
const runParse = (field: Field, value: string): unknown => {
  if (!field.parse) throw new Error(`"${field.name}" has no parse`);
  return field.parse(value);
};

describe("fields behaviour", () => {
  describe("aggregate integer fields", () => {
    const field = getListingAggregateFields()[0]!;
    test("are required, non-negative-integer number fields", () => {
      expect(field.type).toBe("number");
      expect(field.required).toBe(true);
      expect(field.min).toBe(0);
    });
    test("accept a non-negative integer", () => {
      accepts(field, "5");
      accepts(field, "0");
    });
    test("reject a negative, a fraction, and a non-number", () => {
      rejects(field, "-1");
      rejects(field, "1.5");
      rejects(field, "abc");
    });
  });

  describe("modifier fields", () => {
    const modifierFields = getModifierForm().fields;
    test("resolves translated labels when the form is built", () => {
      const fixedLabelWith = (replacement: string): string => {
        using _env = withEnv({
          I18N_REPLACEMENTS: `fixed|${replacement}`,
        });
        resetI18nForTest();
        const field = byName(getModifierForm().fields, "calc_kind");
        if (field.type !== "select") {
          throw new Error("calc_kind must be a select field");
        }
        return field.options[0].label;
      };

      try {
        expect(fixedLabelWith("first")).toBe("First amount");
        expect(fixedLabelWith("second")).toBe("Second amount");
      } finally {
        resetI18nForTest();
      }
    });
    test("name is required", () => {
      expect(byName(modifierFields, "name").required).toBe(true);
    });
    test("calc_value requires a finite number", () => {
      const calc = byName(modifierFields, "calc_value");
      expect(calc.required).toBe(true);
      accepts(calc, "5");
      accepts(calc, "1.5");
      rejects(calc, "abc");
    });
    test("min_subtotal parses blank to 0 and validates a currency amount", () => {
      const field = byName(modifierFields, "min_subtotal");
      expect(runParse(field, "")).toBe(0);
      expect(runParse(field, "5")).toBe(5);
      accepts(field, "5");
      rejects(field, "not-money");
    });
    test("min_visits parses blank to 0 and floors at 0", () => {
      const field = byName(modifierFields, "min_visits");
      expect(runParse(field, "")).toBe(0);
      expect(runParse(field, "3")).toBe(3);
      expect(field.min).toBe(0);
    });
  });

  describe("listing form fields", () => {
    const fields = getListingForm().fields;
    test("capacity fields are required with sensible minimums", () => {
      expect(byName(fields, "max_attendees").min).toBe(1);
      expect(byName(fields, "max_attendees").required).toBe(true);
      expect(byName(fields, "max_quantity").min).toBe(1);
      expect(byName(fields, "max_quantity").required).toBe(true);
      expect(byName(fields, "minimum_days_before").min).toBe(0);
      expect(byName(fields, "maximum_days_after").min).toBe(0);
    });
    test("duration_days accepts 1..MAX and rejects outside/non-integer", () => {
      const duration = byName(fields, "duration_days");
      expect(duration.min).toBe(1);
      accepts(duration, "1");
      accepts(duration, String(MAX_DURATION_DAYS));
      rejects(duration, "0");
      rejects(duration, "1.5");
      rejects(duration, String(MAX_DURATION_DAYS + 1));
    });
    test("the date field rejects an unparseable datetime", () => {
      rejects(byName(fields, "date"), "not-a-datetime");
    });
    test("the contact-fields setting only accepts known field names", () => {
      const contact = byName(fields, "fields");
      accepts(contact, "email");
      rejects(contact, "not-a-contact-field");
    });
    test("the description field renders markdown", () => {
      expect(byName(fields, "description").markdown).toBe(true);
    });
    test("max_price defaults to 100 in the store's currency", () => {
      expect(Number(byName(fields, "max_price").defaultValue)).toBe(100);
    });
  });

  describe("month-count fields keep their bounds", () => {
    test("months-per-unit is 0..24", () => {
      const field = byName(getListingForm().fields, "months_per_unit");
      expect(field.min).toBe(0);
      expect(field.max).toBe(24);
    });
    test("initial-site-months is 0..120", () => {
      const field = byName(getListingForm().fields, "initial_site_months");
      expect(field.min).toBe(0);
      expect(field.max).toBe(120);
    });
  });

  describe("required flags and validators on the remaining factories", () => {
    test("built-site name and url are required; updates only accepts a tier", () => {
      const fields = getBuiltSiteForm().fields;
      expect(byName(fields, "name").required).toBe(true);
      expect(byName(fields, "site_url").required).toBe(true);
      const updates = byName(fields, "updates");
      accepts(updates, "release");
      rejects(updates, "not-a-tier");
    });
    test("the logistics-agent name is required", () => {
      expect(byName(logisticsAgentForm.fields, "name").required).toBe(true);
    });
    test("the slug field is required", () => {
      expect(getSlugField().required).toBe(true);
    });
    test("group name is required and its terms render markdown", () => {
      const fields = getGroupCreateForm().fields;
      expect(byName(fields, "name").required).toBe(true);
      expect(byName(fields, "terms_and_conditions").markdown).toBe(true);
    });
    test("ticket name and email fields are required", () => {
      const fields = getTicketFields("email", false);
      expect(byName(fields, "name").required).toBe(true);
      expect(byName(fields, "email").required).toBe(true);
    });
  });
});
