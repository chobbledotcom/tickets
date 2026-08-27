import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { recalculateRowsFor } from "#templates/admin/recalculate-rows.ts";

describe("recalculateRowsFor", () => {
  const fields = [
    { label: "Booked", name: "booked" },
    { label: "Tickets", name: "tickets" },
  ];
  const buildRows = recalculateRowsFor<"booked" | "tickets">(() => fields);

  test("shows the stored and recounted value for each field", () => {
    const rows = buildRows({
      booked: { current: 3, recalculated: 5 },
      tickets: { current: 10, recalculated: 10 },
    });
    expect(rows).toEqual([
      { current: "3", label: "Booked", name: "booked", recalculated: "5" },
      {
        current: "10",
        label: "Tickets",
        name: "tickets",
        recalculated: "10",
      },
    ]);
  });

  // The field labels come from t(), so they must be read per request rather
  // than frozen when the module loads.
  test("reads the field list again on every call", () => {
    let label = "First";
    const rows = recalculateRowsFor<"booked">(() => [
      { label, name: "booked" },
    ]);
    const snapshot = { booked: { current: 1, recalculated: 2 } };
    expect(rows(snapshot)[0]?.label).toBe("First");
    label = "Second";
    expect(rows(snapshot)[0]?.label).toBe("Second");
  });

  test("throws, naming the field, when the snapshot is missing one", () => {
    const missing = { booked: { current: 3, recalculated: 5 } } as Record<
      "booked" | "tickets",
      { current: number; recalculated: number }
    >;
    expect(() => buildRows(missing)).toThrow(
      'Recalculate snapshot is missing the "tickets" field',
    );
  });
});
