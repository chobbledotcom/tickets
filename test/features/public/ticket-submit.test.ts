import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ChildAllocation } from "#db/attendee-types.ts";
import { withPaidBookingMetadata } from "#routes/public/ticket-submit.ts";
import type { CheckoutIntent } from "#shared/payments.ts";

const intent: CheckoutIntent = {
  address: "",
  date: null,
  email: "buyer@example.com",
  items: [
    {
      listingId: 1,
      name: "Parent",
      quantity: 1,
      slug: "parent",
      unitPrice: 1000,
    },
  ],
  name: "Buyer",
  phone: "",
  special_instructions: "",
};

const allocation: ChildAllocation = { childId: 2, parentId: 1, qty: 1 };

describe("withPaidBookingMetadata", () => {
  test("carries non-empty child allocations", () => {
    expect(
      withPaidBookingMetadata(intent, {
        allocations: [allocation],
        foldedListingCount: 2,
        pageListingCount: 1,
        thankYouUrl: null,
      }),
    ).toEqual({ ...intent, allocations: [allocation] });
  });

  test("omits an empty child allocation list", () => {
    expect(
      withPaidBookingMetadata(intent, {
        allocations: [],
        foldedListingCount: 2,
        pageListingCount: 1,
        thankYouUrl: null,
      }),
    ).toEqual(intent);
  });

  test("carries a parent redirect only when folding added a listing", () => {
    expect(
      withPaidBookingMetadata(intent, {
        allocations: [],
        foldedListingCount: 2,
        pageListingCount: 1,
        thankYouUrl: "/thanks",
      }),
    ).toEqual({ ...intent, thankYouUrl: "/thanks" });
    expect(
      withPaidBookingMetadata(intent, {
        allocations: [],
        foldedListingCount: 1,
        pageListingCount: 1,
        thankYouUrl: "/thanks",
      }),
    ).toEqual(intent);
  });
});
