import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  appendJournalEntry,
  journalEntry,
  type MutationRunSummary,
  readJournal,
  readRunSummary,
  runSummaryPath,
  writeRunSummary,
} from "#scripts/mutation/run-journal.ts";

const summary = (): MutationRunSummary => ({
  effective: 63,
  exhaustive: false,
  finishedAt: "2026-10-26T12:00:00.000Z",
  harness: true,
  ignored: 1,
  killed: 62,
  score: 98.4,
  sources: ["src/features/admin/scan-decision.ts"],
  survived: 0,
  tests: ["test/features/admin/scan-decision.test.ts"],
  total: 63,
});

describe("mutation run journal", () => {
  test("the journal line names the run, the checkout, and the numbers", () => {
    assertEquals(
      journalEntry("mutation-20261026T120000Z-4b463cf0", "abc1234", summary()),
      {
        ...summary(),
        commit: "abc1234",
        id: "mutation-20261026T120000Z-4b463cf0",
      },
    );
  });

  test("a checkout without a commit is recorded as null", () => {
    assertEquals(journalEntry("run-1", null, summary()).commit, null);
  });

  test("a written summary reads back whole, and a missing one reads as none", async () => {
    const root = await Deno.makeTempDir();
    try {
      await writeRunSummary(root, summary());
      assertEquals(await readRunSummary(root), summary());
      assertEquals(await readRunSummary(join(root, "nope")), null);
      assertEquals(runSummaryPath(root), join(root, "summary.json"));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("appended runs read back oldest first, one JSON line each", async () => {
    const root = await Deno.makeTempDir();
    try {
      // The journal lives inside the checkout's scripts/mutation/, which a
      // real checkout always carries; the temp root needs it made here.
      await Deno.mkdir(join(root, "scripts/mutation"), { recursive: true });
      const first = journalEntry("run-1", "aaa", summary());
      const second = journalEntry("run-2", "bbb", {
        ...summary(),
        killed: 40,
        score: 80.0,
        survived: 3,
      });
      await appendJournalEntry(root, second);
      await appendJournalEntry(root, first);
      const lines = await readJournal(root);
      assertEquals(lines, [second, first]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
