import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { toCamelCase } from "#shared/column-names.ts";

describe("column names", () => {
  test("toCamelCase converts snake_case to camelCase", () => {
    expect(
      ["max_attendees", "thank_you_url", "name", "payment_id"].map(toCamelCase),
    ).toEqual(["maxAttendees", "thankYouUrl", "name", "paymentId"]);
  });
});
