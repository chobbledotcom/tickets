import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  countsByRule,
  freshBaseline,
  readCommentFiles,
  runCommentSteCheck,
} from "#scripts/check-comments/ste-run.ts";
import type { PerFileFinding, Registry } from "#scripts/check-runner.ts";
import { checkScriptRun } from "#test-utils/check-script.ts";

/** One finding a rule holds, at the line the rule reports. */
const finding = (rule: string, line = 1): PerFileFinding => ({
  fix: `fix the ${rule}`,
  line,
  problem: rule,
  rule,
});

describe("comment language baseline", () => {
  test("counts findings by rule", () => {
    expect(
      countsByRule([
        finding("contraction"),
        finding("contraction"),
        finding("long-sentence"),
      ]),
    ).toEqual({ contraction: 2, "long-sentence": 1 });
  });

  test("freshBaseline keeps only files with findings, in scan order", async () => {
    const baseline = await freshBaseline([
      {
        file: "src/b.ts",
        findings: [finding("contraction", 1), finding("contraction", 2)],
      },
      { file: "src/c.ts", findings: [finding("semicolon")] },
      { file: "src/a.ts", findings: [finding("wordy")] },
    ]);

    expect(Object.keys(baseline)).toEqual(["src/b.ts", "src/c.ts", "src/a.ts"]);
    expect(baseline["src/b.ts"]).toEqual({ contraction: 2 });
  });
});

describe("comment language scan", () => {
  const run = checkScriptRun();

  test("reads authored TypeScript and JavaScript", async () => {
    await run.write("src/a.ts", "// don't ship this.\n");
    await run.write("src/ui/client/scanner.js", "// simply wait.\n");

    const files = await readCommentFiles(run.path);

    expect(Object.fromEntries(files.map(({ file }) => [file, 1]))).toEqual({
      [join(run.path, "src/a.ts")]: 1,
      [join(run.path, "src/ui/client/scanner.js")]: 1,
    });
  });

  test("reads the published documentation barrels", async () => {
    await run.write("src/doc.ts", "// don't ship this.\n");
    await run.write("src/docs/notes.ts", "// simply wait.\n");

    const files = await readCommentFiles(run.path);

    expect(files.map(({ file }) => file)).toEqual([
      join(run.path, "src/doc.ts"),
      join(run.path, "src/docs/notes.ts"),
    ]);
  });

  test("leaves shipped migrations and built bundles out", async () => {
    await run.write(
      "src/db/migrations/2062-01-01_note.ts",
      "// don't ship this.\n",
    );
    await run.write("src/ui/static/bundle.js", "// simply wait.\n");

    expect(await readCommentFiles(run.path)).toEqual([]);
  });
});

describe("comment language check shell", () => {
  const run = checkScriptRun();

  const baselinePath = (): string => join(run.path, "baseline.json");

  const writeBaselineFile = async (baseline: Registry): Promise<void> =>
    await Deno.writeTextFile(baselinePath(), JSON.stringify(baseline));

  const scan = async (): Promise<Registry> =>
    await freshBaseline(await readCommentFiles(run.path));

  test("a risen finding names its file, line, and rule", async () => {
    await run.write("src/a.ts", "// don't ship this.\n");
    await writeBaselineFile({});

    const code = runCommentSteCheck(
      await readCommentFiles(run.path),
      {},
      run.output,
    );

    expect(code).toBe(1);
    expect(
      run.errors.some((line) =>
        line.includes(`${join(run.path, "src/a.ts")}:1 [contraction]: "don't"`),
      ),
    ).toBe(true);
    expect(run.errors.some((line) => line.includes("1 comment-language"))).toBe(
      true,
    );
  });

  test("a held finding stays quiet and reports success", async () => {
    await run.write("src/a.ts", "// don't ship this.\n");
    await writeBaselineFile(await scan());

    const code = runCommentSteCheck(
      await readCommentFiles(run.path),
      await scan(),
      run.output,
    );

    expect(code).toBe(0);
    expect(run.logs[0]).toContain("holds no comment-language finding");
  });

  test("a fallen count asks for --update and fails until it is recorded", async () => {
    await run.write("src/a.ts", "// don't ship this.\n");
    const recorded = await scan();
    recorded[join(run.path, "src/a.ts")] = { contraction: 2, wordy: 1 };
    await writeBaselineFile(recorded);

    const code = runCommentSteCheck(
      await readCommentFiles(run.path),
      recorded,
      run.output,
    );

    expect(code).toBe(1);
    expect(
      run.errors.some((line) => line.includes("fewer findings than recorded")),
    ).toBe(true);
    expect(run.errors.some((line) => line.includes("--update"))).toBe(true);
  });

  test("a rule the file no longer carries also asks for --update", async () => {
    await run.write("src/a.ts", "// don't ship this.\n");
    const file = join(run.path, "src/a.ts");

    const code = runCommentSteCheck(
      await readCommentFiles(run.path),
      { [file]: { contraction: 1, wordy: 1 } },
      run.output,
    );

    expect(code).toBe(1);
    expect(
      run.errors.some((line) => line.includes("fewer findings than recorded")),
    ).toBe(true);
  });

  test("a baseline entry whose file the scan no longer reads fails", async () => {
    await run.write("src/a.ts", "// clean prose.\n");
    const gone = join(run.path, "src/gone.ts");
    await writeBaselineFile({ [gone]: { contraction: 1 } });

    const code = runCommentSteCheck(
      await readCommentFiles(run.path),
      { [gone]: { contraction: 1 } },
      run.output,
    );

    expect(code).toBe(1);
    expect(
      run.errors.some((line) => line.includes(gone) && line.includes("stale")),
    ).toBe(true);
  });

  test("a shipped-migration file is not scanned", async () => {
    await run.write(
      "src/db/migrations/2062-01-01_note.ts",
      "// don't ship this.\n",
    );
    await writeBaselineFile({});

    const code = runCommentSteCheck(
      await readCommentFiles(run.path),
      {},
      run.output,
    );

    expect(code).toBe(0);
    expect(run.errors).toHaveLength(0);
  });
});
