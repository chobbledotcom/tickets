// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { csvDateColumn } from "#test/specs/support/evidence.ts";

// jscpd:ignore-end

describe("csvDateColumn", () => {
  test("keeps the exported dates without attendee personal data", () => {
    expect(
      csvDateColumn(
        "Date,Name,Email,Phone\n2026-08-16 to 2026-08-17,Jane Doe,jane@example.com,07123456789",
      ),
    ).toBe("Date\n2026-08-16 to 2026-08-17");
  });
});
