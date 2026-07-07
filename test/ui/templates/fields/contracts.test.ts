import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Field } from "#shared/forms.tsx";
import {
  extractContact,
  getAddAttendeeFields,
  getChangePasswordFields,
  getInviteUserFields,
  getLoginFields,
  getSetupFields,
  getSquareAccessTokenFields,
  getSquareWebhookFields,
  getStripeKeyFields,
  getSumupFields,
  type TicketFormValues,
} from "#templates/fields.ts";
import { byName, hasField } from "#test-utils/fields.ts";

describe("fields contracts", () => {
  describe("field lookup helpers", () => {
    test("byName throws loudly when the named field is absent", () => {
      expect(() => byName([], "missing")).toThrow('no "missing" field');
    });
  });

  describe("extractContact", () => {
    test("passes present contact values straight through", () => {
      const values: TicketFormValues = {
        address: "1 High Street",
        email: "person@example.com",
        name: "Alex",
        phone: "01234 567890",
        special_instructions: "Leave at door",
      };
      expect(extractContact(values)).toEqual(values);
    });

    test("defaults every optional field to an empty string", () => {
      // Only name is guaranteed; the rest must fall back to "" (not undefined
      // and not some other placeholder).
      const contact = extractContact({ name: "Alex" } as TicketFormValues);
      expect(contact).toEqual({
        address: "",
        email: "",
        name: "Alex",
        phone: "",
        special_instructions: "",
      });
    });
  });

  describe("getAddAttendeeFields", () => {
    const fields = "email,phone";

    test("quantity is a required number of at least 1", () => {
      const quantity = byName(getAddAttendeeFields(fields, false), "quantity");
      expect(quantity.type).toBe("number");
      expect(quantity.required).toBe(true);
      expect(quantity.min).toBe(1);
    });

    test("the date field appears — and is required — only for daily listings", () => {
      expect(hasField(getAddAttendeeFields(fields, false), "date")).toBe(false);
      const date = byName(getAddAttendeeFields(fields, true), "date");
      expect(date.type).toBe("date");
      expect(date.required).toBe(true);
    });

    test("the day-count select appears only when day counts are supplied", () => {
      // Daily but no day counts → no selector.
      expect(hasField(getAddAttendeeFields(fields, true), "day_count")).toBe(
        false,
      );
      // A single day count (length 1) still adds it — guards the `> 0` bound.
      const one = byName(getAddAttendeeFields(fields, true, [1]), "day_count");
      expect(one.type).toBe("select");
      expect(one.required).toBe(true);
    });

    test("day-count options are labelled singular/plural by day count", () => {
      const select = byName(
        getAddAttendeeFields(fields, true, [1, 3]),
        "day_count",
      );
      expect((select.options ?? []).map((o) => o.label)).toEqual([
        "1 day",
        "3 days",
      ]);
    });
  });

  describe("password fields", () => {
    test("a new-password field enforces an 8-char minimum; its confirm twin does not", () => {
      const setup = getSetupFields();
      const password = byName(setup, "admin_password");
      expect(password.type).toBe("password");
      expect(password.required).toBe(true);
      expect(password.minlength).toBe(8);

      const confirm = byName(setup, "admin_password_confirm");
      expect(confirm.required).toBe(true);
      // The confirm field must NOT carry a minlength — it only has to match.
      expect(confirm.minlength).toBeUndefined();
    });

    test("change-password reuses the same new-password rules", () => {
      const fields = getChangePasswordFields();
      expect(byName(fields, "current_password").required).toBe(true);
      expect(byName(fields, "new_password").minlength).toBe(8);
      expect(byName(fields, "new_password_confirm").minlength).toBeUndefined();
    });
  });

  describe("required flags across the settings/auth factories", () => {
    // Each factory's fields are all required; a `required: true -> false` mutant
    // on any of them flips one of these to false.
    const cases: Array<[string, Field[]]> = [
      ["login", getLoginFields()],
      ["setup", getSetupFields()],
      ["stripe key", getStripeKeyFields()],
      ["square token", getSquareAccessTokenFields()],
      ["square webhook", getSquareWebhookFields()],
      ["sumup", getSumupFields()],
      ["invite user", getInviteUserFields()],
    ];
    for (const [label, fields] of cases) {
      test(`every ${label} field is required`, () => {
        expect(fields.length).toBeGreaterThan(0);
        for (const field of fields) {
          expect(field.required).toBe(true);
        }
      });
    }

    test("the login username field keeps its 2–32 length bounds", () => {
      const username = byName(getLoginFields(), "username");
      expect(username.minlength).toBe(2);
      expect(username.maxlength).toBe(32);
    });

    test("the invite-user role is a required select", () => {
      const role = byName(getInviteUserFields(), "admin_level");
      expect(role.type).toBe("select");
      expect(role.required).toBe(true);
    });
  });
});
