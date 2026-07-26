import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { nearCapacity } from "#templates/admin/listings/aggregates.tsx";
import { registerListingTemplateHooks } from "#test/ui/templates/admin/listings/helpers.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describe("nearCapacity", () => {
  registerListingTemplateHooks();

  test("returns true when at 90% capacity", () => {
    const listing = testListingWithCount({
      attendee_count: 90,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(true);
  });

  test("returns true when over 90% capacity", () => {
    const listing = testListingWithCount({
      attendee_count: 95,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(true);
  });

  test("returns false when under 90% capacity", () => {
    const listing = testListingWithCount({
      attendee_count: 89,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(false);
  });

  test("returns true when fully sold out", () => {
    const listing = testListingWithCount({
      attendee_count: 100,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(true);
  });
});
