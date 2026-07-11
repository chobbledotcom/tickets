import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { soldOutLabel } from "#templates/public/reservations/listing-rows.ts";

describe("soldOutLabel", () => {
  test("shows the Sold Out badge by default", () => {
    expect(soldOutLabel()).toBe('<span class="sold-out-label">Sold Out</span>');
  });

  test("shows the caller's copy when given", () => {
    expect(soldOutLabel("Registration Closed")).toBe(
      '<span class="sold-out-label">Registration Closed</span>',
    );
  });
});
