import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  camelCaseKeys,
  fieldName,
  snakeCaseKeys,
} from "#shared/column-names.ts";

describe("column names", () => {
  test("fieldName converts snake_case to camelCase", () => {
    expect(
      ["max_attendees", "thank_you_url", "name", "payment_id"].map(fieldName),
    ).toEqual(["maxAttendees", "thankYouUrl", "name", "paymentId"]);
  });

  test("camelCaseKeys renames each column of a row and keeps its value", () => {
    expect(
      camelCaseKeys({ id: 3, min_visits: 0, thank_you_url: "/done" }),
    ).toEqual({ id: 3, minVisits: 0, thankYouUrl: "/done" });
  });

  test("snakeCaseKeys renames each code name to its column and keeps its value", () => {
    expect(
      snakeCaseKeys({ externalIdIndex: null, linkId: 7, name: "Pool" }),
    ).toEqual({ external_id_index: null, link_id: 7, name: "Pool" });
  });
});
