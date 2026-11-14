import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withoutKey } from "#shared/without-key.ts";

describe("withoutKey", () => {
  test("copies every other key and leaves the input whole", () => {
    const row = { attendee_id: 7, listing_id: 3, quantity: 2 };
    expect(withoutKey("attendee_id")(row)).toEqual({
      listing_id: 3,
      quantity: 2,
    });
    expect(row).toEqual({ attendee_id: 7, listing_id: 3, quantity: 2 });
  });
});
