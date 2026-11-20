import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resetI18nForTest } from "#i18n";
import type { Field } from "#shared/forms/field.ts";
import {
  getBuiltSiteForm,
  getLogisticsAgentForm,
} from "#templates/fields/admin.ts";
import { getListingAggregateFields } from "#templates/fields/aggregate.ts";
import { getGroupCreateForm } from "#templates/fields/group.ts";
import { getListingForm } from "#templates/fields/listing.ts";
import { getModifierForm } from "#templates/fields/modifier.ts";
import { getTicketFields } from "#templates/fields/ticket.ts";
import { getSlugField } from "#templates/fields/validators.ts";
import { withEnv } from "#test-utils/env.ts";
import { byName } from "#test-utils/fields.ts";
import { MAX_DURATION_DAYS } from "#types";

/** Run a field's `validate` (present on the fields under test here). */
const runValidate = (field: Field, value: string): string | null => {
  if (!field.validate) throw new Error(`"${field.name}" has no validate`);
  return field.validate(value);
};
const expectAccepts = (field: Field, value: string) =>
  expect(runValidate(field, value)).toBeNull();
const expectRejects = (field: Field, value: string) =>
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
      expectAccepts(field, "5");
      expectAccepts(field, "0");
    });
    test("reject a fraction and a non-number", () => {
      // The declared min of 0 refuses a negative; the field's own check
      // refuses only what the schema cannot see.
      expectRejects(field, "1.5");
      expectRejects(field, "abc");
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
        const field = byName(getModifierForm().fields, "calcKind");
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
      const calc = byName(modifierFields, "calcValue");
      expect(calc.required).toBe(true);
      expectAccepts(calc, "5");
      expectAccepts(calc, "1.5");
      expectRejects(calc, "abc");
    });
    test("min_subtotal parses blank to 0 and validates a currency amount", () => {
      const field = byName(modifierFields, "minSubtotal");
      expect(runParse(field, "")).toBe(0);
      expect(runParse(field, "5")).toBe(5);
      expectAccepts(field, "5");
      expectRejects(field, "not-money");
    });
    test("min_visits parses blank to 0 and floors at 0", () => {
      const field = byName(modifierFields, "minVisits");
      expect(runParse(field, "")).toBe(0);
      expect(runParse(field, "3")).toBe(3);
      expect(field.min).toBe(0);
    });
  });

  describe("listing form fields", () => {
    const fields = getListingForm().fields;
    test("capacity fields are required with sensible minimums", () => {
      expect(byName(fields, "maxAttendees").min).toBe(1);
      expect(byName(fields, "maxAttendees").required).toBe(true);
      expect(byName(fields, "maxQuantity").min).toBe(1);
      expect(byName(fields, "maxQuantity").required).toBe(true);
      expect(byName(fields, "minimumDaysBefore").min).toBe(0);
      expect(byName(fields, "maximumDaysAfter").min).toBe(0);
    });
    test("whole-number catalog kinds refuse a fraction like the API does", () => {
      // The kind is the shared declaration: the listing JSON API refuses the
      // same fraction for every field here.
      for (const name of [
        "maxAttendees",
        "maxQuantity",
        "minQuantity",
        "minimumDaysBefore",
        "maximumDaysAfter",
        "monthsPerUnit",
        "initialSiteMonths",
      ]) {
        expectRejects(byName(fields, name), "1.5");
      }
    });
    test("duration_days accepts 1..MAX and rejects a fraction", () => {
      const duration = byName(fields, "durationDays");
      expect(duration.min).toBe(1);
      expect(duration.max).toBe(MAX_DURATION_DAYS);
      expectAccepts(duration, "1");
      expectAccepts(duration, String(MAX_DURATION_DAYS));
      // The declared min/max refuse the outside values; the field's own
      // check refuses a fraction.
      expectRejects(duration, "1.5");
    });
    test("the date field rejects an unparseable datetime", () => {
      expectRejects(byName(fields, "date"), "not-a-datetime");
    });
    test("the contact-fields setting only accepts known field names", () => {
      const contact = byName(fields, "fields");
      expectAccepts(contact, "email");
      expectRejects(contact, "not-a-contact-field");
    });
    test("the description field renders markdown", () => {
      expect(byName(fields, "description").markdown).toBe(true);
    });
    test("max_price defaults to 100 in the store's currency", () => {
      expect(Number(byName(fields, "maxPrice").defaultValue)).toBe(100);
    });
  });

  describe("month-count fields keep their bounds", () => {
    test("months-per-unit is 0..24 and initial-site-months is 0..120", () => {
      const bounds = (name: string) => {
        const field = byName(getListingForm().fields, name);
        return [field.min, field.max];
      };
      expect(bounds("monthsPerUnit")).toEqual([0, 24]);
      expect(bounds("initialSiteMonths")).toEqual([0, 120]);
    });
  });

  describe("required flags and validators on the remaining factories", () => {
    test("built-site name and url are required; updates only accepts a tier", () => {
      const fields = getBuiltSiteForm().fields;
      expect(byName(fields, "name").required).toBe(true);
      expect(byName(fields, "siteUrl").required).toBe(true);
      const updates = byName(fields, "updates");
      expectAccepts(updates, "release");
      expectRejects(updates, "not-a-tier");
    });
    test("the logistics-agent name is required", () => {
      expect(byName(getLogisticsAgentForm().fields, "name").required).toBe(
        true,
      );
    });
    test("the slug field is required", () => {
      expect(getSlugField().required).toBe(true);
    });
    test("group name is required and its terms render markdown", () => {
      const fields = getGroupCreateForm().fields;
      expect(byName(fields, "name").required).toBe(true);
      expect(byName(fields, "termsAndConditions").markdown).toBe(true);
    });
    test("group max attendees refuses a fraction like the group API does", () => {
      expect(byName(getGroupCreateForm().fields, "maxAttendees").min).toBe(0);
      expectRejects(byName(getGroupCreateForm().fields, "maxAttendees"), "1.5");
    });
    test("ticket name and email fields are required", () => {
      const fields = getTicketFields("email", false);
      expect(byName(fields, "name").required).toBe(true);
      expect(byName(fields, "email").required).toBe(true);
    });
  });
});
