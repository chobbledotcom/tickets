import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  baselineRose,
  type DocumentFile,
  freshBaseline,
  freshEntry,
  markdownFilesIn,
  markdownFilesUnder,
  readDocuments,
  runSteCheck,
} from "#scripts/check-ste/run.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";

describe("reading the markdown the check covers", () => {
  let dir: TempPath;

  const makeDocs = () => {
    Deno.mkdirSync(`${dir.path}/docs`);
    Deno.mkdirSync(`${dir.path}/cli`);
    Deno.mkdirSync(`${dir.path}/scripts`, { recursive: true });
    Deno.mkdirSync(`${dir.path}/.hidden`);
    Deno.writeTextFileSync(`${dir.path}/AGENTS.md`, "Write it.\n");
    Deno.writeTextFileSync(`${dir.path}/notes.txt`, "not markdown\n");
    Deno.writeTextFileSync(`${dir.path}/docs/one.md`, "Write one.\n");
    Deno.writeTextFileSync(`${dir.path}/docs/two.md`, "Write two.\n");
    Deno.writeTextFileSync(`${dir.path}/cli/README.md`, "Write three.\n");
    Deno.writeTextFileSync(`${dir.path}/scripts/README.md`, "Write four.\n");
    Deno.writeTextFileSync(`${dir.path}/.hidden/secret.md`, "Write five.\n");
  };

  test("markdownFilesIn lists only .md files in one folder, sorted", async () => {
    await withTemp(async () => {
      makeDocs();
      expect(await markdownFilesIn(dir.path)).toEqual([
        `${dir.path}/AGENTS.md`,
      ]);
      expect(await markdownFilesIn(`${dir.path}/docs`)).toEqual([
        `${dir.path}/docs/one.md`,
        `${dir.path}/docs/two.md`,
      ]);
    });
  });

  test("markdownFilesUnder walks a tree, minus hidden folders", async () => {
    await withTemp(async () => {
      makeDocs();
      expect(await markdownFilesUnder(`${dir.path}/scripts`)).toEqual([
        `${dir.path}/scripts/README.md`,
      ]);
    });
  });

  test("readDocuments reads the root files plus every named tree, sorted", async () => {
    await withTemp(async () => {
      makeDocs();
      const documents: DocumentFile[] = await readDocuments(dir.path, [
        `${dir.path}/docs`,
        `${dir.path}/cli`,
        `${dir.path}/scripts`,
      ]);
      expect(documents.map((one) => one.path)).toEqual([
        `${dir.path}/AGENTS.md`,
        `${dir.path}/cli/README.md`,
        `${dir.path}/docs/one.md`,
        `${dir.path}/docs/two.md`,
        `${dir.path}/scripts/README.md`,
      ]);
      expect(documents[0]?.content).toBe("Write it.\n");
    });
  });

  const withTemp = async (run: () => Promise<void>) => {
    dir = tempDir();
    try {
      await run();
    } finally {
      dir.dispose();
    }
  };
});

describe("check-ste runner", () => {
  const output = {
    log: () => {},
    logError: () => {},
  };

  const file = (path: string, content: string): DocumentFile => ({
    content,
    path,
  });

  /** Run the check over one document and one baseline entry, and hand back
   * the exit code plus the lines sent to the error logger. */
  const checkAgainst = (
    content: string,
    entry: Record<string, number>,
  ): { code: number; errors: string[] } => {
    const errors: string[] = [];
    const code = runSteCheck(
      [file("a.md", content)],
      {},
      { "a.md": entry },
      {
        log: () => {},
        logError: (line) => errors.push(line),
      },
    );
    return { code, errors };
  };

  test("passes a document at its baseline, rule by rule", () => {
    const files = [
      file("a.md", "Write it; then stop. It may fail.\n"),
      file("b.md", "Write b; one.\n"),
    ];
    const atBaseline = {
      "a.md": { "banned-modal": 1, semicolon: 1 },
      "b.md": { semicolon: 1 },
    };
    expect(runSteCheck(files, {}, atBaseline, output)).toBe(0);
    // b.md's allowance was recorded for a rule it does not break, so its
    // semicolon rose.
    expect(
      runSteCheck(
        files,
        {},
        { ...atBaseline, "b.md": { participle: 1 } },
        output,
      ),
    ).toBe(1);
  });

  test("fails when one rule rose, naming that rule's findings only", () => {
    const { code, errors } = checkAgainst("Write; one. It may fail.\n", {
      semicolon: 1,
    });
    expect(code).toBe(1);
    expect(errors[0]).toBe(
      'a.md:1 [banned-modal]: "may" — use can, will, or must',
    );
    expect(errors[1]).toContain("1 technical-english issue(s) found");
  });

  test("keeps a grandfathered semicolon from paying for a new modal", () => {
    // The document held one semicolon; the writer removed it and added a
    // banned modal. Totals match, rules do not.
    const { code, errors } = checkAgainst("It may fail.\n", { semicolon: 1 });
    expect(code).toBe(1);
    expect(errors[0]).toContain("[banned-modal]");
  });

  test("fails when a document improved, so the update lands with its step", () => {
    const { code, errors } = checkAgainst("Write one; note.\n", {
      semicolon: 3,
    });
    expect(code).toBe(1);
    expect(errors[0]).toContain("a.md [improved]");
    expect(errors[0]).toContain("--update");
  });

  test("fails when a document holds no findings any more", () => {
    const { code, errors } = checkAgainst("Write it clean.\n", {
      semicolon: 1,
    });
    expect(code).toBe(1);
    expect(errors[0]).toContain("a.md [improved]");
  });

  test("a document with no entry must be clean", () => {
    const files = [file("new.md", "Write it; then stop.\n")];
    expect(runSteCheck(files, {}, {}, output)).toBe(1);
    expect(runSteCheck(files, {}, { "new.md": { semicolon: 1 } }, output)).toBe(
      0,
    );
  });

  test("skips a record document, however it reads", async () => {
    const files = [file("plan.md", "It's been; simply made, would you not.\n")];
    expect(runSteCheck(files, { "plan.md": "a record" }, {}, output)).toBe(0);
    expect(await freshBaseline(files, { "plan.md": "a record" })).toEqual({});
  });

  test("freshBaseline records every non-record document's counts", async () => {
    const documents = [
      file("a.md", "Write; one.\n"),
      file("plan.md", "It's been; simply made.\n"),
    ];
    expect(await freshBaseline(documents, { "plan.md": "a record" })).toEqual({
      "a.md": { semicolon: 1 },
    });
  });

  test("fails for a records or baseline entry that names no document", () => {
    const files = [file("a.md", "Write it.\n")];
    const errors: string[] = [];
    const code = runSteCheck(
      files,
      { "gone.md": "a record" },
      { "also-gone.md": {} },
      {
        ...output,
        logError: (line) => errors.push(line),
      },
    );
    expect(code).toBe(1);
    expect(errors[0]).toContain("also-gone.md");
    expect(errors[0]).toContain("baseline.json");
    expect(errors[1]).toContain("gone.md");
    expect(errors[1]).toContain("records.json");
  });

  test("logs the success line when everything matches", () => {
    const lines: string[] = [];
    const code = runSteCheck(
      [file("a.md", "Write it.\n")],
      {},
      {},
      { ...output, log: (line) => lines.push(line) },
    );
    expect(code).toBe(0);
    expect(lines).toEqual([
      "Every policy document passes the simplified-technical-english checks.",
    ]);
  });
});

describe("the baseline the update step records", () => {
  test("freshEntry counts each rule and drops the rules that find nothing", () => {
    expect(freshEntry("Write; one. It may fail.\n")).toEqual({
      "banned-modal": 1,
      semicolon: 1,
    });
    expect(freshEntry("Write it clean.\n")).toEqual({});
  });

  test("baselineRose answers yes only when some rule's count rose", () => {
    const recorded = { "a.md": { semicolon: 2 } };
    expect(baselineRose(recorded, { "a.md": { semicolon: 2 } })).toBe(false);
    expect(baselineRose(recorded, { "a.md": { semicolon: 1 } })).toBe(false);
    expect(baselineRose(recorded, { "a.md": { semicolon: 3 } })).toBe(true);
    expect(baselineRose(recorded, { "b.md": { semicolon: 1 } })).toBe(true);
    expect(baselineRose(recorded, {})).toBe(false);
  });
});
