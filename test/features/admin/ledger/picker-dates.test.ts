import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { pickerDatesFromBounds } from "#routes/admin/ledger/picker-dates.ts";

const ms = (iso: string): number => new Date(iso).getTime();

describe("pickerDatesFromBounds", () => {
  test("is empty when the ledger has no transfers", () => {
    expect(pickerDatesFromBounds(null, "2026-06-21", "UTC")).toEqual([]);
  });

  test("runs from the earliest transfer to the latest when it is after today", () => {
    const dates = pickerDatesFromBounds(
      { maxMs: ms("2026-06-22T00:00:00Z"), minMs: ms("2026-06-20T00:00:00Z") },
      "2026-06-21",
      "UTC",
    );
    expect(dates.map((date) => date.value)).toEqual([
      "2026-06-20",
      "2026-06-21",
      "2026-06-22",
    ]);
    expect(dates.every((date) => date.selectable)).toBe(true);
  });

  test("extends the end to today when the latest transfer is older", () => {
    const dates = pickerDatesFromBounds(
      { maxMs: ms("2026-06-20T00:00:00Z"), minMs: ms("2026-06-20T00:00:00Z") },
      "2026-06-23",
      "UTC",
    );
    expect(dates.map((date) => date.value)).toEqual([
      "2026-06-20",
      "2026-06-21",
      "2026-06-22",
      "2026-06-23",
    ]);
  });
});
