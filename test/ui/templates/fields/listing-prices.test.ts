import { describe, it as test } from "@std/testing/bdd";
import {
  listingForm,
  ownerFields,
} from "#test/ui/templates/fields/listing/owner-form.ts";
import { expectInvalid, expectValid } from "#test-utils/validation.ts";

describe("listing form pricing", () => {
  test("rejects negative unit_price", () => {
    expectInvalid("Price must be 0 or greater")(
      ownerFields(),
      listingForm({ unitPrice: "-100" }),
    );
  });

  test("rejects negative max_price and accepts valid values", () => {
    expectInvalid("Price must be 0 or greater")(
      ownerFields(),
      listingForm({ maxPrice: "-50" }),
    );
    expectValid(ownerFields(), listingForm({ maxPrice: "100.00" }));
  });

  test("rejects a blank max_price box instead of reading it as a default", () => {
    expectInvalid("Enter a maximum price. Type 0 for no maximum.")(
      ownerFields(),
      listingForm({ maxPrice: "" }),
    );
  });
});

describe("listing form count boxes", () => {
  test("rejects a blank count box instead of taking its default", () => {
    for (const [box, label] of [
      ["durationDays", "Booking duration (days)"],
      ["maximumDaysAfter", "Maximum days ahead (for daily listings)"],
      ["minimumDaysBefore", "Minimum days notice (for daily listings)"],
      ["minQuantity", "Min tickets per purchase"],
      ["maxQuantity", "Max tickets per purchase"],
    ] as const) {
      expectInvalid(`${label} is required`)(
        ownerFields(),
        listingForm({ [box]: "" }),
      );
    }
  });
});
