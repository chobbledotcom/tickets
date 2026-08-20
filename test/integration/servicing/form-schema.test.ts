/**
 * Servicing §0 — pure unit tests for the servicing field schema, form parser,
 * kind-aware normalisation, and validation reuse.
 *
 * The servicing form is a trimmed version of the attendee form: name + the
 * booking grid + (locked) hidden-from-public indicator. The submit core is a
 * thin specialisation of the attendee submit core that:
 *
 *   • parses the same booking grid (`qty_<id>`, `line_key_<id>`,
 *     `noqty_<id>`, `day_count`, `start_date`) and the same `name`;
 *   • normalises by `kind='servicing'` — contact / status / balance fields
 *     are coerced empty / null / zero server-side regardless of what the POST
 *     body carried (§3 / §19 contract guard);
 *   • reuses `validateAttendeeBlock` (exported from `attendee-form-model.ts`)
 *     for the name-required rule so name-only is valid and a blank name is
 *     rejected (`error.name_required`).
 *
 * Modules under test:
 *   - `#routes/admin/servicing/form-model.ts` — `buildServicingFieldSchema`,
 *     `parseServicingForm`, `normalizeServicingForSave`,
 *     `ServicingCreateInput`.
 *   - `#routes/admin/attendee-form-model.ts` — the shared `validateAttendeeBlock`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#db/attendees/kind.ts";
import { t } from "#i18n";
import { QTY_PREFIX } from "#routes/admin/attendee-form-lines.ts";
import {
  DAY_COUNT_FIELD,
  parseAttendeeForm,
  START_DATE_FIELD,
  validateAttendeeBlock,
} from "#routes/admin/attendee-form-model.ts";
import {
  buildServicingFieldSchema,
  normalizeServicingForSave,
  parseServicingForm,
} from "#routes/admin/servicing/form-model.ts";
import { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";

// jscpd:ignore-end

const EXCLUDED_FIELD_NAMES = [
  "email",
  "phone",
  "address",
  "special_instructions",
  "status_id",
  "remaining_balance",
] as const;

const fieldNames = (fields: readonly Field[]): Set<string> =>
  new Set(fields.map((f) => f.name));

describe("servicing §0 — servicing field schema omits contact/payment fields", () => {
  const fields = buildServicingFieldSchema();

  test("the schema includes the name and the booking-grid controls", () => {
    const names = fieldNames(fields);
    expect(names.has("name")).toBe(true);
    // The booking grid is shared with the attendee form — the same field names
    // drive the same per-listing quantity input. We assert presence of the
    // shared date + day-count controls (the per-listing qty_* fields are
    // emitted dynamically per listing, not as static Field entries).
    expect(names.has(START_DATE_FIELD)).toBe(true);
    expect(names.has(DAY_COUNT_FIELD)).toBe(true);
    expect(names.has(QTY_PREFIX.slice(0, -1))).toBe(false); // prefix isn't a field
  });

  for (const name of EXCLUDED_FIELD_NAMES) {
    test(`the schema excludes ${name} (mutation: re-adding it fails)`, () => {
      const names = fieldNames(fields);
      expect(names.has(name)).toBe(false);
    });
  }

  test("the schema carries no field whose name is a contact field (,count guard)", () => {
    // A gappy mutant that drops two excluded fields but adds two new ones
    // with the same names would slip past the per-name assertions above. This
    // pins the *count* of contact-named fields to zero.
    const contactFields = fields.filter((f) =>
      (EXCLUDED_FIELD_NAMES as readonly string[]).includes(f.name),
    );
    expect(contactFields).toEqual([]);
  });
});

describe("servicing §0 — parse servicing form maps to a kind='servicing' create input", () => {
  // The parser is pure given a listings-by-id map. We hand it a minimal shape
  // that mirrors the in-app usage (a single daily listing at capacity 1).
  const listingsById = new Map([
    [
      1,
      {
        attendee_count: 0,
        id: 1,
        income: 0,
        listing_type: "daily" as const,
        max_attendees: 5,
        max_quantity: 5,
        name: "Room A",
        slug: "room-a",
        tickets_count: 0,
      },
    ],
  ]);

  test("parsing a name + quantity_1 submission yields a kind='servicing' input with the booked line and empty contact fields", () => {
    const form = new FormParams({
      day_count: "1",
      name: "Boiler Service",
      quantity_1: "2",
      [START_DATE_FIELD]: "2026-06-24",
    });
    const parsed = parseServicingForm(form, listingsById);
    const input = normalizeServicingForSave(parsed);
    expect(input.kind).toBe(SERVICING_KIND);
    expect(input.name).toBe("Boiler Service");
    expect(input.bookings).toEqual([
      expect.objectContaining({
        date: "2026-06-24",
        listingId: 1,
        quantity: 2,
      }),
    ]);
    // Contact fields are empty by construction even on the create input.
    expect(input).not.toHaveProperty("email");
    expect(input).not.toHaveProperty("phone");
    expect(input).not.toHaveProperty("address");
    expect(input).not.toHaveProperty("special_instructions");
  });

  test("a crafted servicing POST smuggling contact/payment fields is normalised away (kind owns state, not the template)", () => {
    // The smuggler the §3/§19 contract guards against: extra email/phone/etc
    // in the POST body must not survive into the create input.
    const form = new FormParams({
      address: "12 Sneaky Street",
      day_count: "1",
      email: "smuggler@example.com",
      name: "Boiler Service",
      phone: "+44 7700 900000",
      quantity_1: "1",
      remaining_balance: "9000",
      special_instructions: "be quiet",
      [START_DATE_FIELD]: "2026-06-24",
      status_id: "3",
    });
    const parsed = parseServicingForm(form, listingsById);
    const normalised = normalizeServicingForSave(parsed);
    expect(normalised.kind).toBe(SERVICING_KIND);
    expect(normalised).not.toHaveProperty("email");
    expect(normalised).not.toHaveProperty("phone");
    expect(normalised).not.toHaveProperty("address");
    expect(normalised).not.toHaveProperty("special_instructions");
    // statusId and remainingBalance are coerced null/0.
    expect(normalised).not.toHaveProperty("statusId");
    expect(normalised).not.toHaveProperty("remainingBalance");
  });
});

describe("servicing §0 — servicing form validation requires a name (reuses validateAttendeeBlock)", () => {
  // `validateAttendeeBlock` is the shared block; servicing reuses the same
  // name-required rule. name-only is valid; a blank name is rejected.
  test("a blank name returns the name-required error", () => {
    const blank = parseAttendeeForm(
      new FormParams({
        name: "",
        quantity_1: "1",
        [START_DATE_FIELD]: "2026-06-24",
      }),
      new Map(),
    );
    const error = validateAttendeeBlock(blank);
    expect(error).not.toBeNull();
    expect(error?.field).toBe("name");
    expect(error?.message).toBe(t("error.name_required"));
  });

  test("a name with no email is valid (proves name-only is acceptable)", () => {
    const nameOnly = parseAttendeeForm(
      new FormParams({
        name: "Boiler Service",
        quantity_1: "1",
        [START_DATE_FIELD]: "2026-06-24",
      }),
      new Map(),
    );
    expect(validateAttendeeBlock(nameOnly)).toBeNull();
  });
});

describe("servicing §0 — servicing skips order/status/balance resolution", () => {
  // The pure helper that normalises a servicing submission for save must NOT
  // derive a status / balance / balance notice from the parsed form — those
  // customer-only resolutions are skipped for kind='servicing'.
  const parsedShape = {
    address: "",
    dayCount: 3,
    email: "",
    lines: [],
    name: "Annual Inspection",
    phone: "",
    remainingBalance: 9000, // smuggled — must be ignored
    returnUrl: "",
    special_instructions: "",
    startDate: "2026-06-24",
    statusId: 3, // smuggled — must be ignored
  } as const;

  test("the saved shape carries only name + bookings + kind — no customer fields", () => {
    // The exact keys of the saved input: a mutant that forwards a smuggled
    // statusId / remainingBalance / balanceNotice adds a key and fails here.
    // (`?? null` on a missing key would hide that leak.)
    const out = normalizeServicingForSave(parsedShape as never) as Record<
      string,
      unknown
    >;
    expect(Object.keys(out).sort()).toEqual(["bookings", "kind", "name"]);
    expect(out).not.toHaveProperty("statusId");
    expect(out).not.toHaveProperty("remainingBalance");
    expect(out).not.toHaveProperty("balanceNotice");
  });

  test("quantity-0 sentinel lines are stripped from servicing saves (not passed to creation)", () => {
    // normalizeServicingForSave filters zero-quantity bookings so an operator
    // leaving a listing unchecked on the form doesn't generate a 0-qty slot.
    // The lower-level validation's 'capacity slot' guard never sees these.
    const out = normalizeServicingForSave({
      ...parsedShape,
      lines: [
        {
          error: null,
          existingBooking: null,
          key: "",
          listing: {
            id: 1,
            listing_type: "standard",
            max_quantity: 5,
          },
          listingId: 1,
          noQuantity: true,
          quantity: 0,
        },
      ],
    } as never);
    expect(out.bookings).toEqual([]);
  });
});
