import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { HolidayRowSchema } from "#shared/admin-api-resources.ts";

describe("admin api resource table", () => {
  test("a holiday row keeps the fields the table does not name", () => {
    const row = v.parse(HolidayRowSchema, {
      created: "2026-10-07T00:00:00.000Z",
      end_date: "2026-10-10",
      id: 3,
      name: "Fair week",
      start_date: "2026-10-08",
    });
    expect(row).toMatchObject({ id: 3, name: "Fair week" });
    expect((row as Record<string, unknown>).created).toBe(
      "2026-10-07T00:00:00.000Z",
    );
  });
});
