import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import {
  getSetupState,
  invalidateTestDbCache,
  reusableSetupState,
  writeTestState,
} from "#test-utils/test-state.ts";

describe("test-state", () => {
  test("writeTestState builds a golden DB and a replayable setup state", async () => {
    const dir = await Deno.makeTempDir({ prefix: "tickets-test-state-test-" });
    try {
      await writeTestState(dir);

      // The golden DB is a real SQLite file with the app schema in it.
      const golden = await Deno.stat(`${dir}/golden.db`);
      expect(golden.size).toBeGreaterThan(0);

      // The captured state carries everything a fixture replays: the setup
      // ceremony's settings, the owner user, and a live admin session.
      const state = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
      expect(state.country).toBe("GB");
      expect(state.users).toHaveLength(1);
      expect(state.session.cookie).toContain("=");
      const keys = state.settings.map((row: { key: string }) => row.key);
      expect(keys).toContain("setup_complete");
      // The scratch DB the ceremony ran on is cleaned away.
      await expect(Deno.stat(`${dir}/setup-work.db`)).rejects.toThrow();
    } finally {
      await Deno.remove(dir, { recursive: true });
      resetDb();
    }
  });

  test("invalidateTestDbCache pins the next fixture to the real ceremony", async () => {
    await createTestDb();
    try {
      invalidateTestDbCache();
      expect(getSetupState()).toBe(null);
      // Even when a run-wide snapshot exists (the harness exports one for this
      // very test run), an explicit invalidate must not re-seed from it.
      expect(reusableSetupState("GB")).toBe(null);
    } finally {
      resetDb();
    }
  });
});
