import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  type MutantResult,
  summarize,
  writeStepSummary,
} from "#scripts/mutation/summary.ts";
import { tempFile } from "#test-utils/files.ts";
import {
  fakeResult,
  plain,
  timingSummary,
  withStepSummary,
} from "./fixtures.ts";

describe("the Markdown mutation report", () => {
  /** The Markdown one writeStepSummary call appended. */
  const stepSummary = async (results: MutantResult[]): Promise<string> => {
    using file = tempFile({ prefix: "mutation-summary-" });
    return await withStepSummary(file.path, () =>
      writeStepSummary(summarize(results)),
    );
  };

  test("calls a run with nothing to mutate inconclusive", async () => {
    expect(await stepSummary([])).toBe(
      [
        "## \u{1f9ec} Mutation testing",
        "",
        "\u26a0\ufe0f **Inconclusive** \u2014 no mutable operators were found, so nothing was" +
          " mutated. A mutation score needs at least one mutant.",
        "",
      ].join("\n"),
    );
  });

  test("says so when every mutant is a known-equivalent", async () => {
    expect(await stepSummary([fakeResult("ignored", 1, "??", "||")])).toBe(
      [
        "## \u{1f9ec} Mutation testing",
        "",
        "\u2705 All 1 mutant(s) suppressed as known-equivalent \u2014 nothing killable.",
        "",
      ].join("\n"),
    );
  });

  test("counts the mutants and notes the suppressed ones", async () => {
    expect(
      await stepSummary([
        fakeResult("killed", 2, "===", "!=="),
        fakeResult("ignored", 3, "??", "||"),
      ]),
    ).toBe(
      [
        "## \u{1f9ec} Mutation testing",
        "",
        "\u2705 **All 1 mutants detected** \u2014 score 100.0%, 1 suppressed",
        "",
        "| metric | count |",
        "| --- | --- |",
        "| mutants | 2 |",
        "| killed | 1 |",
        "| survived | 0 |",
        "| ignored (suppressed) | 1 |",
        "",
      ].join("\n"),
    );
  });

  test("tables the survivors so a reviewer can see each one", async () => {
    expect(
      await stepSummary([
        fakeResult("killed", 1, "===", "!=="),
        fakeResult("survived", 4, "return x", "return undefined"),
      ]),
    ).toBe(
      [
        "## \u{1f9ec} Mutation testing",
        "",
        "\u274c **1 mutant(s) survived** \u2014 score 50.0% (detected 1/2)",
        "",
        "| metric | count |",
        "| --- | --- |",
        "| mutants | 2 |",
        "| killed | 1 |",
        "| survived | 1 |",
        "",
        "### Survivors",
        "",
        "These mutations did not fail any test:",
        "",
        "| location | registry entry |",
        "| --- | --- |",
        "| <code>src/example.ts:4:3</code> |" +
          " <code>src/example.ts::fn4 return x\u2192return undefined</code> |",
        "",
        "Proven unkillable by any test? Paste its line above into a file" +
          " under scripts/mutation/equivalent-mutants/, followed by  # and the" +
          " reason.",
        "",
      ].join("\n"),
    );
  });

  // A raw `|` splits a Markdown row into another column even inside a code
  // span, and `??` → `||` is the commonest mutation this report shows.
  test("keeps a survivor holding pipes inside one table cell", async () => {
    const summary = await stepSummary([fakeResult("survived", 7, "??", "||")]);
    const row = summary.split("\n").find((line) => line.includes("fn7"))!;

    expect(row).toContain("&#124;&#124;");
    expect(row.split("|")).toHaveLength(4);
  });

  test("keeps earlier step summaries when it writes another", async () => {
    using file = tempFile({ prefix: "mutation-summary-append-" });
    const text = await withStepSummary(file.path, () => {
      writeStepSummary(summarize([]));
      writeStepSummary(summarize([fakeResult("ignored", 1, "??", "||")]));
    });

    expect(text).toContain("Inconclusive");
    expect(text).toContain("nothing killable");
  });

  test("says on the console where the Markdown summary went", async () => {
    using file = tempFile({ prefix: "mutation-summary-log-" });
    const logs: string[] = [];
    using _log = stub(console, "log", (line?: unknown) => {
      logs.push(String(line));
    });

    await withStepSummary(file.path, () => writeStepSummary(summarize([])));

    expect(logs.map(plain)).toEqual([
      "Wrote Markdown summary to $GITHUB_STEP_SUMMARY.",
    ]);
  });

  test("writes phase timing work in Markdown summaries", async () => {
    using file = tempFile({ prefix: "mutation-timing-summary-" });
    const markdown = await withStepSummary(file.path, () =>
      writeStepSummary(timingSummary()),
    );
    expect(markdown.split("\n").slice(-10, -3)).toEqual([
      "",
      "### Phase timings",
      "",
      "These are cumulative phase times across mutant attempts. Parallel test" +
        " batches count once per stage.",
      "",
      "| phase | runs | time |",
      "| --- | ---: | ---: |",
    ]);
    expect(markdown).toContain("| lint | 1 | 4ms |");
    expect(markdown).toContain("| direct-tests | 1 | 10ms |");
  });

  test("writes phase timing work when all mutants are ignored", async () => {
    using file = tempFile({ prefix: "mutation-ignored-timing-summary-" });
    const markdown = await withStepSummary(file.path, () =>
      writeStepSummary(timingSummary("ignored")),
    );

    expect(markdown).toContain("### Phase timings");
    expect(markdown).toContain("| direct-tests | 1 | 10ms |");
  });

  test("ignores absent or unwritable GitHub step summary paths", async () => {
    await withStepSummary(null, () => writeStepSummary(summarize([])));
    await withStepSummary("/tmp/missing-dir/mutation-summary.md", () =>
      writeStepSummary(summarize([fakeResult("killed", 1, "true", "false")])),
    );
  });
});
