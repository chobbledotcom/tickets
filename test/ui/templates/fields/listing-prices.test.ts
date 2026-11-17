import { describe, it as test } from "@std/testing/bdd";
import { getListingForm, listingFormView } from "#templates/fields/listing.ts";
import { baseListingForm } from "#test-utils/factories.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { expectInvalid, expectValid } from "#test-utils/validation.ts";

const listingForm = (overrides: TestFormValues = {}): TestFormValues => ({
  ...baseListingForm,
  ...overrides,
});

describe("listing form pricing", () => {
  test("rejects negative unit_price", () => {
    expectInvalid("Price must be 0 or greater")(
      getListingForm(listingFormView("owner")).fields,
      listingForm({ unitPrice: "-100" }),
    );
  });

  test("rejects negative max_price and accepts valid values", () => {
    expectInvalid("Price must be 0 or greater")(
      getListingForm(listingFormView("owner")).fields,
      listingForm({ maxPrice: "-50" }),
    );
    expectValid(
      getListingForm(listingFormView("owner")).fields,
      listingForm({ maxPrice: "100.00" }),
    );
  });

  test("rejects a blank max_price box instead of reading it as a default", () => {
    expectInvalid("Enter a maximum price. Type 0 for no maximum.")(
      getListingForm(listingFormView("owner")).fields,
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
        getListingForm(listingFormView("owner")).fields,
        listingForm({ [box]: "" }),
      );
    }
  });
});
