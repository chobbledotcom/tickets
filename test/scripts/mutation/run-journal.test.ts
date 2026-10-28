import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  MUTATION_RUN_ROOT_ENV,
  newRunRecord,
} from "#scripts/mutation/isolation-state.ts";
import {
  appendJournalEntry,
  appendRunJournalEntry,
  MUTATION_JOURNAL_PATH,
  type MutationRunSummary,
  publishRunSummary,
  readJournal,
  readRunSummary,
  runSummaryPath,
  writeRunSummary,
} from "#scripts/mutation/run-journal.ts";
import type { MutantResult } from "#scripts/mutation/summary.ts";
import { fakeResult } from "#test/scripts/mutation/summary/fixtures.ts";
import { withEnv } from "#test-utils/env.ts";

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

/** A commit a checkout's HEAD could name. */
const HEAD = "9c1e2b64a7d8f0e3a1b2c4d5e6f708192a3b4c5d";

/** A run record shaped for the supervisor's fold, settled as conclusive. */
const recordShaped = (id: string, root: string) => ({
  ...newRunRecord(id, [], root),
  status: "passed" as const,
});

/** The journal's lines, or none when nothing was appended — a run that
 *  publishes nothing leaves no file behind to read. */
const readJournalLines = async (root: string) => {
  if (
    !(await Deno.stat(join(root, MUTATION_JOURNAL_PATH)).then(
      () => true,
      () => false,
    ))
  ) {
    return [];
  }
  return await readJournal(root);
};

/** One child-side publish: the env names the run root, and the call's error
 *  lines come back for assertion. */
const publishInto = async (
  runRoot: string | undefined,
  results: MutantResult[],
): Promise<string[]> => {
  const errors: string[] = [];
  using _env = withEnv({ [MUTATION_RUN_ROOT_ENV]: runRoot });
  using _error = stub(console, "error", (...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  });
  await publishRunSummary(
    {
      exhaustive: false,
      sourceFiles: ["src/a.ts"],
      testFiles: ["test/a.test.ts"],
      useHarness: true,
    },
    results,
  );
  return errors;
};

/** One settled run in a sandbox checkout: its journal directory made, its
 *  summary written where the supervisor's fold reads it. */
const settledRun = async (root: string, id: string) => {
  await Deno.mkdir(join(root, "scripts/mutation"), { recursive: true });
  const record = recordShaped(id, root);
  await Deno.mkdir(record.root, { recursive: true });
  await writeRunSummary(record.root, summary());
  return record;
};

describe("mutation run journal", () => {
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
      const first = { ...summary(), commit: "aaa", id: "run-1" };
      const second = {
        ...summary(),
        commit: "bbb",
        id: "run-2",
        killed: 40,
        score: 80.0,
        survived: 3,
      };
      await appendJournalEntry(root, second);
      await appendJournalEntry(root, first);
      const lines = await readJournal(root);
      assertEquals(lines, [second, first]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("a run outside a snapshot publishes nothing", async () => {
    const errors = await publishInto(undefined, [
      fakeResult("killed", 1, "true", "false"),
    ]);

    assertEquals(errors, []);
  });

  test("a conclusive run inside a snapshot writes its numbers", async () => {
    const root = await Deno.makeTempDir();
    try {
      const errors = await publishInto(root, [
        fakeResult("killed", 1, "true", "false"),
        fakeResult("killed", 2, "&&", "||"),
        fakeResult("survived", 3, "??", "||"),
        fakeResult("ignored", 4, "0", "1"),
      ]);
      assertEquals(errors, []);

      const written = JSON.parse(
        await Deno.readTextFile(join(root, "summary.json")),
      );
      // The suppressed-equivalent mutant stays out of the score's denominator.
      assertEquals(written, {
        effective: 3,
        exhaustive: false,
        finishedAt: written.finishedAt,
        harness: true,
        ignored: 1,
        killed: 2,
        score: (2 / 3) * 100,
        sources: ["src/a.ts"],
        survived: 1,
        tests: ["test/a.test.ts"],
        total: 4,
      });
      // The timestamp names the write moment, not a constant a stale run
      // could leave behind.
      assert(Math.abs(Date.now() - Date.parse(written.finishedAt)) < 60_000);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("a summary it cannot write is reported and never fails the run", async () => {
    const root = await Deno.makeTempDir();
    try {
      // The run root sits under a directory that does not exist, so the
      // write throws and only the report may answer for it.
      const errors = await publishInto(join(root, "missing", "deeper"), [
        fakeResult("killed", 1, "true", "false"),
      ]);

      assertEquals(errors.length, 1);
      assertStringIncludes(
        errors[0] ?? "",
        "could not be published for the mutation journal",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("a run the deadline or an interrupt stopped appends nothing", async () => {
    const root = await Deno.makeTempDir();
    try {
      await writeRunSummary(root, summary());
      await appendRunJournalEntry(root, {
        ...recordShaped("run-1", root),
        status: "interrupted",
      });
      assertEquals(await readJournalLines(root), []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("a conclusive run's summary lands as one stamped line", async () => {
    const root = await Deno.makeTempDir();
    try {
      const record = await settledRun(root, "run-1");
      await appendRunJournalEntry(root, record, async () => HEAD);

      const [line] = await readJournal(root);
      assert(line !== undefined);
      assertEquals(line.id, "run-1");
      assertEquals(line.killed, 62);
      assertEquals(line.score, 98.4);
      assertEquals(line.commit, HEAD);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("a checkout without a commit stamps the line with null", async () => {
    const root = await Deno.makeTempDir();
    try {
      const record = await settledRun(root, "run-1");
      await appendRunJournalEntry(root, record, async () => undefined);

      const [line] = await readJournal(root);
      assert(line !== undefined);
      assertEquals(line.id, "run-1");
      assertEquals(line.commit, null);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("a conclusive run whose child wrote no summary appends nothing", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(root, "scripts/mutation"), { recursive: true });
      await appendRunJournalEntry(root, recordShaped("run-1", root));
      assertEquals(await readJournalLines(root), []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
