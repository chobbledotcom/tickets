import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hasLedgerName } from "#routes/admin/ledger/names.ts";

test("cost accounts use their listing name", () => {
  const names = {
    attendees: new Map<number, string>(),
    listings: new Map([[7, "Boiler service"]]),
    modifiers: new Map<number, string>(),
  };

  expect(hasLedgerName("cost", "7", names)).toBe(true);
  expect(hasLedgerName("cost", "8", names)).toBe(false);
});
