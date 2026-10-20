/* jscpd:ignore-start -- imports */
import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AttendeeStatus } from "#db/attendee-statuses.ts";
import {
  isBookedLine,
  isNoQuantityLine,
  isRetainedLine,
  resolveStatusId,
  validateParsedForm,
} from "#routes/admin/attendee-form-model.ts";
import {
  line,
  parsedBase,
} from "#test/features/admin/attendee-form-model/fixtures.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

/* jscpd:ignore-end */

describe("isBookedLine", () => {
  test("true only when quantity ≥ 1 and the listing resolves", () => {
    expect(isBookedLine(line({ quantity: 2 }))).toBe(true);
    expect(isBookedLine(line({ quantity: 0 }))).toBe(false);
    expect(isBookedLine(line({ quantity: null }))).toBe(false);
    expect(isBookedLine(line({ listing: null }))).toBe(false);
  });
});

describe("isNoQuantityLine / isRetainedLine", () => {
  test("a no-quantity line is not booked but is retained", () => {
    const noQty = line({ noQuantity: true, quantity: 0 });
    expect(isBookedLine(noQty)).toBe(false);
    expect(isNoQuantityLine(noQty)).toBe(true);
    expect(isRetainedLine(noQty)).toBe(true);
  });

  test("an unbooked line (qty 0, box unticked) is neither retained nor no-quantity", () => {
    const removed = line({ noQuantity: false, quantity: 0 });
    expect(isNoQuantityLine(removed)).toBe(false);
    expect(isRetainedLine(removed)).toBe(false);
  });

  test("a real booking is retained", () => {
    expect(isRetainedLine(line({ quantity: 2 }))).toBe(true);
  });

  test("a no-quantity tick on an unresolved listing is ignored", () => {
    expect(
      isNoQuantityLine(line({ listing: null, noQuantity: true, quantity: 0 })),
    ).toBe(false);
  });
});

describe("resolveStatusId", () => {
  const status = (id: number, isPublicDefault: boolean): AttendeeStatus => ({
    id,
    is_paid_default: false,
    is_public_default: isPublicDefault,
    is_reservation: false,
    name: `Status ${id}`,
    reservation_amount: "0",
    sort_order: id,
  });

  test("keeps an explicitly chosen status", () => {
    expect(resolveStatusId(2, [status(1, true), status(2, false)])).toBe(2);
  });

  test("falls back to the public default when none is given", () => {
    expect(resolveStatusId(null, [status(1, false), status(2, true)])).toBe(2);
  });
});

describe("validateParsedForm", () => {
  test("fails when name is blank", () => {
    const result = validateParsedForm(parsedBase({ name: "" }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.attendeeError?.field).toBe("name");
  });

  test("fails when the name is too long for checkout metadata", () => {
    const result = validateParsedForm(parsedBase({ name: "n".repeat(251) }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.attendeeError?.field).toBe("name");
      expect(result.attendeeError?.message).toBe(
        "Name must be 250 characters or fewer",
      );
    }
  });

  test("passes for a booked standard listing with no date", () => {
    const result = validateParsedForm(parsedBase({ lines: [line()] }));
    expect(result.valid).toBe(true);
  });

  test("fails when a booked quantity exceeds the listing max", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [
          line({
            listing: testListingWithCount({ id: 1, max_quantity: 5 }),
            quantity: 10,
          }),
        ],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      assertStringIncludes(result.lineErrors.get(0) ?? "", "at most 5");
    }
  });

  test("treats a 0-quantity line as not booked, not an error", () => {
    const result = validateParsedForm(
      parsedBase({ lines: [line({ quantity: 0 })] }),
    );
    expect(result.valid).toBe(true);
  });

  test("ignores an unbooked line whose listing is unknown", () => {
    const result = validateParsedForm(
      parsedBase({ lines: [line({ listing: null, quantity: 1 })] }),
    );
    expect(result.valid).toBe(true);
  });

  test("allows keeping a booked inactive listing", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [
          line({ listing: testListingWithCount({ active: false, id: 1 }) }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("fails when a daily listing is booked but the start date is missing", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [
          line({
            listing: testListingWithCount({ id: 1, listing_type: "daily" }),
          }),
        ],
        startDate: "",
      }),
    );
    expect(result.valid).toBe(false);
    assert(!result.valid);
    assertStringIncludes(result.dateError ?? "", "start date");
  });

  test("passes a booked daily listing with a valid start date", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [
          line({
            listing: testListingWithCount({ id: 1, listing_type: "daily" }),
          }),
        ],
        startDate: "2026-03-02",
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("rejects a malformed email, phone, address and instructions", () => {
    expect(
      validateParsedForm(parsedBase({ email: "nope", lines: [line()] })).valid,
    ).toBe(false);
    expect(
      validateParsedForm(parsedBase({ lines: [line()], phone: "not a phone" }))
        .valid,
    ).toBe(false);
    expect(
      validateParsedForm(
        parsedBase({ address: "x".repeat(251), lines: [line()] }),
      ).valid,
    ).toBe(false);
    expect(
      validateParsedForm(
        parsedBase({ lines: [line()], special_instructions: "x".repeat(251) }),
      ).valid,
    ).toBe(false);
  });

  test("accepts well-formed optional email and phone", () => {
    const result = validateParsedForm(
      parsedBase({
        email: "jane@example.com",
        lines: [line()],
        phone: "+1 (555) 123-4567",
      }),
    );
    expect(result.valid).toBe(true);
  });
});
