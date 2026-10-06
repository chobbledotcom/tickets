/** The toggle-state rule one listing lifecycle shares. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingToggleStateError } from "#routes/admin/listing-toggle-state.ts";

describe("listing toggle state rule", () => {
  test("refuses a deactivation of a listing that is already off", () => {
    expect(listingToggleStateError(false, false)).toBe(
      "This listing is already deactivated. Nothing to do.",
    );
  });

  test("refuses a reactivation of a listing that is already on", () => {
    expect(listingToggleStateError(true, true)).toBe(
      "This listing is already active. Nothing to do.",
    );
  });

  test("allows a toggle that changes the stored state", () => {
    expect(listingToggleStateError(true, false)).toBeNull();
    expect(listingToggleStateError(false, true)).toBeNull();
  });
});
