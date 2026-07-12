import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildRecalculateRows } from "#templates/admin/recalculate-rows.ts";

describe("buildRecalculateRows", () => {
  const fields = [
    { label: "Booked", name: "booked" },
    { label: "Tickets", name: "tickets" },
  ];
  const snapshot = {
    booked: { current: 3, recalculated: 5 },
    tickets: { current: 10, recalculated: 10 },
  };
  const format = (name: "booked" | "tickets", value: number): string =>
    `${name}=${value}`;

  test("formats the stored and recounted value for each field", () => {
    const rows = buildRecalculateRows(fields, format, snapshot);
    expect(rows).toEqual([
      {
        current: "booked=3",
        label: "Booked",
        name: "booked",
        recalculated: "booked=5",
      },
      {
        current: "tickets=10",
        label: "Tickets",
        name: "tickets",
        recalculated: "tickets=10",
      },
    ]);
  });

  test("throws, naming the field, when the snapshot is missing one", () => {
    const missing = { booked: { current: 3, recalculated: 5 } } as Record<
      "booked" | "tickets",
      { current: number; recalculated: number }
    >;
    expect(() => buildRecalculateRows(fields, format, missing)).toThrow(
      'Recalculate snapshot is missing the "tickets" field',
    );
  });
});
