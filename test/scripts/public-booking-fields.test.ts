/**
 * The public booking docs and the ticket validator are one fact. The docs
 * list the contact keys a booking body takes. The validator lists the fields
 * a booking form asks for. The two sets must match, so a change on one side
 * cannot leave the docs behind.
 *
 * The docs also list keys that only a booking body takes: `children`, `date`,
 * `quantity`, `customPrice`, and `dayCount`. The validator has no such
 * fields. The docs key `special_instructions` is the form key
 * `specialInstructions`.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  LISTING_BOOKING_FIELDS,
  PACKAGE_BOOKING_FIELDS,
} from "#routes/api/request-schemas.ts";
import { getTicketFields } from "#templates/fields/ticket.ts";
import { CONTACT_FIELDS } from "#types";

/** The documented keys that a booking body takes beyond the contact fields. */
const BOOKING_ONLY_KEYS: Readonly<Record<string, true>> = {
  children: true,
  customPrice: true,
  date: true,
  dayCount: true,
  quantity: true,
};

/** The form field name of one documented contact key. */
const FORM_KEY_OF: Readonly<Record<string, string>> = {
  special_instructions: "specialInstructions",
};

/** The contact keys a documented booking body lists, under form names. */
const documentedContactKeys = (fields: Record<string, unknown>): string[] =>
  Object.keys(fields)
    .filter((key) => BOOKING_ONLY_KEYS[key] !== true)
    .map((key) => FORM_KEY_OF[key] ?? key)
    .sort();

/** The contact field names the ticket validator asks for. Only the required
 *  ones need a documented key. */
const validatorContactKeys = (requiredOnly = false): string[] =>
  getTicketFields(CONTACT_FIELDS.join(","), false)
    .filter((field) => !requiredOnly || field.required)
    .map((field) => field.name)
    .sort();

describe("the public booking docs", () => {
  test("document only contact keys the validator accepts", () => {
    const accepted = new Set(validatorContactKeys());

    for (const fields of [LISTING_BOOKING_FIELDS, PACKAGE_BOOKING_FIELDS]) {
      expect(
        documentedContactKeys(fields).filter((key) => !accepted.has(key)),
      ).toEqual([]);
    }
  });

  test("document every contact field the validator can require", () => {
    expect(documentedContactKeys(LISTING_BOOKING_FIELDS)).toEqual(
      validatorContactKeys(true),
    );
    expect(documentedContactKeys(PACKAGE_BOOKING_FIELDS)).toEqual(
      validatorContactKeys(true),
    );
  });
});
