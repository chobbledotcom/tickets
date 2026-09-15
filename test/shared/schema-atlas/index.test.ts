import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { SCHEMA_ATLAS_MACHINES } from "#shared/schema-atlas/index.ts";

describe("SCHEMA_ATLAS_MACHINES", () => {
  test("maps all four payment machines once, keyed by their own ids", () => {
    expect(SCHEMA_ATLAS_MACHINES.map((machine) => machine.id)).toEqual([
      "refund",
      "review",
      "row",
      "sumup_recovery",
    ]);
  });

  test("titles and intros derive from each machine's id", () => {
    for (const machine of SCHEMA_ATLAS_MACHINES) {
      expect(machine.titleKey).toBe(`schema.${machine.id}.title`);
      expect(machine.introKey).toBe(`schema.${machine.id}.intro`);
    }
  });

  test("every machine maps at least one state", () => {
    for (const machine of SCHEMA_ATLAS_MACHINES) {
      expect(machine.states.length).toBeGreaterThan(0);
    }
  });
});
