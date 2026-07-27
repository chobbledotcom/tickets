import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MUTATION_RUN_ID_ENV,
  MUTATION_RUN_ROOT_ENV,
  MUTATION_SNAPSHOT_CHILD_ENV,
  MUTATION_WORK_ROOT_ENV,
} from "#scripts/mutation/isolation-state.ts";

/** How a run tells its child which snapshot it is working in. */
const HANDOVER_NAMES = [
  MUTATION_SNAPSHOT_CHILD_ENV,
  MUTATION_RUN_ID_ENV,
  MUTATION_RUN_ROOT_ENV,
  MUTATION_WORK_ROOT_ENV,
];

describe("what a run tells its child", () => {
  test("uses a separate name for each thing it passes down", () => {
    expect(new Set(HANDOVER_NAMES).size).toBe(HANDOVER_NAMES.length);
  });

  for (const name of HANDOVER_NAMES) {
    test(`can put ${name || "an unnamed value"} in an environment`, () => {
      // A nameless or "=" bearing variable cannot be set at all, so the child
      // would be started without it and quietly behave as if it were not in a
      // snapshot. Deno is the judge here, not a rule written out again.
      expect(() => Deno.env.set(name, "1")).not.toThrow();
      Deno.env.delete(name);
    });
  }

  test("keeps them under our own prefix, away from anyone else's", () => {
    for (const name of HANDOVER_NAMES) {
      expect(name.startsWith("TICKETS_MUTATION_")).toBe(true);
    }
  });
});
